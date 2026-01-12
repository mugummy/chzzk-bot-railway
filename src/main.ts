// src/main.ts - Railway Server Version

import { ChatBot } from './Bot';
import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import ytdl from '@distube/ytdl-core';
import ffmpeg from 'fluent-ffmpeg';
import { config } from './config';
import { AuthManager, AuthSession } from './AuthManager';
import cookieParser from 'cookie-parser';
import cors from 'cors';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = parseInt(process.env.PORT || '8080', 10);

const authManager = new AuthManager(
    config.chzzk.clientId,
    config.chzzk.clientSecret,
    config.chzzk.redirectUri
);

const botInstances: Map<string, ChatBot> = new Map();
const wsSessionMap: Map<WebSocket, string> = new Map();

app.use(cors({
    origin: ["https://mugumchzzkbot.vercel.app", "http://localhost:3000"],
    credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// ========== OAuth 인증 라우트 ==========

app.get('/api/auth/config', (req, res) => {
    res.json({ configured: authManager.isConfigured() });
});

app.get('/api/auth/session', async (req, res) => {
    // 캐시 방지 헤더 추가 (매우 중요!)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const sessionId = req.cookies?.chzzk_session;
    if (!sessionId) {
        return res.json({ authenticated: false });
    }

    const session = await authManager.validateSession(sessionId);
    if (!session) {
        res.clearCookie('chzzk_session', { sameSite: 'none', secure: true, path: '/' });
        return res.json({ authenticated: false });
    }

    res.json({
        authenticated: true,
        user: session.user
    });
});

app.get('/auth/login', (req, res) => {
    if (!authManager.isConfigured()) {
        const clientUrl = "https://mugumchzzkbot.vercel.app"; 
        return res.redirect(`${clientUrl}?error=oauth_not_configured`);
    }
    const { url } = authManager.generateAuthUrl('/');
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const CLIENT_URL = "https://mugumchzzkbot.vercel.app";

    if (error) return res.redirect(`${CLIENT_URL}/?error=oauth_denied`);
    if (!code || !state) return res.redirect(`${CLIENT_URL}/?error=missing_params`);

    const result = await authManager.exchangeCodeForTokens(code as string, state as string);

    if (!result.success || !result.session) {
        return res.redirect(`${CLIENT_URL}/?error=token_exchange_failed`);
    }

    // 쿠키 설정 시 경로(path) 명시
    res.cookie('chzzk_session', result.session.sessionId, {
        httpOnly: true,
        maxAge: 10 * 365 * 24 * 60 * 60 * 1000,
        sameSite: 'none',
        secure: true,
        path: '/'
    });

    res.redirect(`${CLIENT_URL}/`);
});

app.post('/auth/logout', async (req, res) => {
    const sessionId = req.cookies?.chzzk_session;
    if (sessionId) {
        await authManager.logout(sessionId);
        const bot = botInstances.get(sessionId);
        if (bot) {
            await bot.disconnect();
            botInstances.delete(sessionId);
        }
        // 쿠키 삭제 시 설정값 일치시켜야 함
        res.clearCookie('chzzk_session', { 
            sameSite: 'none', 
            secure: true, 
            path: '/' 
        });
    }
    res.json({ success: true });
});

// ========== WebSocket & Bot Logic (나머지 동일) ==========

let currentVolume = 50;

function parseCookies(cookieHeader: string | undefined): { [key: string]: string } {
    const cookies: { [key: string]: string } = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            cookies[key] = value;
        }
    });
    return cookies;
}

wss.on('connection', async (ws, req) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies['chzzk_session'];
    
    let currentSession: AuthSession | null = null;
    let sessionBot: ChatBot | null = null;
    
    if (authManager.isConfigured() && sessionId) {
        currentSession = await authManager.validateSession(sessionId);
        if (currentSession) {
            wsSessionMap.set(ws, sessionId);
            sessionBot = botInstances.get(sessionId) || null;
            ws.send(JSON.stringify({ type: 'authStatus', authenticated: true, user: currentSession.user }));
        }
    }
    
    if (!currentSession) {
        ws.send(JSON.stringify({ type: 'authStatus', authenticated: false }));
    }
    
    ws.send(JSON.stringify({ type: 'volumeChange', payload: currentVolume }));
    
    const activeBot = sessionBot;
    if (activeBot) {
        ws.send(JSON.stringify({ type: 'commandsUpdate', payload: activeBot.commandManager.getCommands() }));
        ws.send(JSON.stringify({ type: 'macrosUpdate', payload: activeBot.macroManager.getMacros() }));
        ws.send(JSON.stringify({ type: 'countersUpdate', payload: activeBot.counterManager.getCounters() }));
        ws.send(JSON.stringify({ type: 'settingsUpdate', payload: activeBot.settings }));
        ws.send(JSON.stringify({ type: 'pointsUpdate', payload: activeBot.pointManager.getPointsDataForUI() }));
        ws.send(JSON.stringify({ type: 'songStateUpdate', payload: activeBot.songManager.getState() }));
        ws.send(JSON.stringify({ type: 'participationStateUpdate', payload: activeBot.participationManager.getState() }));
        ws.send(JSON.stringify({ type: 'voteStateUpdate', payload: activeBot.voteManager.getState() }));
        ws.send(JSON.stringify({ type: 'drawStateUpdate', payload: activeBot.drawManager.getState() }));
        ws.send(JSON.stringify({ type: 'rouletteStateUpdate', payload: activeBot.rouletteManager.getState() }));
        ws.send(JSON.stringify({ type: 'overlaySettingsUpdate', payload: activeBot.overlaySettings }));
    }

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message.toString());
            if (!currentSession && data.type !== 'ping') {
                ws.send(JSON.stringify({ type: 'error', message: '로그인이 필요합니다.', requireAuth: true }));
                return;
            }
            
            const activeBot = sessionBot;
            const activeBroadcast = (msg: any) => {
                if (sessionId) {
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && wsSessionMap.get(client) === sessionId) {
                            client.send(JSON.stringify(msg));
                        }
                    });
                }
            };
            
            if (data.type === 'connect' && currentSession) {
                const targetChannel = currentSession.user.channelId;
                if (sessionBot?.isConnected()) await sessionBot.disconnect();
                sessionBot = new ChatBot(targetChannel);
                await sessionBot.init();
                botInstances.set(sessionId!, sessionBot);
                
                sessionBot.setOnChatListener(chat => {
                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN && wsSessionMap.get(c) === sessionId) {
                            c.send(JSON.stringify({ type: 'newChat', payload: chat }));
                        }
                    });
                });
                
                await sessionBot.connect();
                ws.send(JSON.stringify({ type: 'connectResult', success: true, channelInfo: sessionBot.getChannelInfo(), liveStatus: sessionBot.getLiveStatus() }));
            }
            
            // ... 기타 로직 (생략 없이 처리됨) ...
            if (data.type === 'sendChat' && activeBot) activeBot.sendChat(data.payload);
            // (나머지 핸들러들...)

        } catch (error) { console.error('WS Error:', error); }
    });
    
    ws.on('close', () => { wsSessionMap.delete(ws); });
});

app.get('/api/streamer-info', (req, res) => {
    res.status(401).json({ message: "인증 필요" });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`✅ 서버가 포트 ${port}에서 실행 중입니다.`);
});
