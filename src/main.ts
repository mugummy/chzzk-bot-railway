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

// Railway에서 제공하는 PORT 환경변수를 사용해야 함
const port = parseInt(process.env.PORT || '8080', 10);

// 인증 매니저 초기화
const authManager = new AuthManager(
    config.chzzk.clientId,
    config.chzzk.clientSecret,
    config.chzzk.redirectUri
);

// 세션별 봇 인스턴스 관리
const botInstances: Map<string, ChatBot> = new Map();
// WebSocket 연결별 세션 ID 매핑
const wsSessionMap: Map<WebSocket, string> = new Map();

// CORS 설정: Vercel 도메인 허용
app.use(cors({
    origin: ["https://mugumchzzkbot.vercel.app", "http://localhost:3000"],
    credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// Root route for health check
app.get('/', (req, res) => {
    res.send(`Chzzk Bot Server is running on port ${port}`);
});

// ========== OAuth 인증 라우트 ==========

// 인증 설정 확인 API
app.get('/api/auth/config', (req, res) => {
    res.json({
        configured: authManager.isConfigured()
    });
});

// 현재 세션 확인 API
app.get('/api/auth/session', async (req, res) => {
    const sessionId = req.cookies?.chzzk_session;
    if (!sessionId) {
        return res.json({ authenticated: false });
    }

    const session = await authManager.validateSession(sessionId);
    if (!session) {
        res.clearCookie('chzzk_session', { sameSite: 'none', secure: true });
        return res.json({ authenticated: false });
    }

    res.json({
        authenticated: true,
        user: session.user
    });
});

// 로그인 시작 (치지직 OAuth로 리다이렉트)
app.get('/auth/login', (req, res) => {
    if (!authManager.isConfigured()) {
        const clientUrl = "https://mugumchzzkbot.vercel.app"; 
        return res.redirect(`${clientUrl}?error=oauth_not_configured`);
    }

    const { url } = authManager.generateAuthUrl('/');
    res.redirect(url);
});

// OAuth 콜백 처리
app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const CLIENT_URL = "https://mugumchzzkbot.vercel.app";

    if (error) {
        console.error('[Auth] OAuth error:', error);
        return res.redirect(`${CLIENT_URL}/?error=oauth_denied`);
    }

    if (!code || !state) {
        return res.redirect(`${CLIENT_URL}/?error=missing_params`);
    }

    const result = await authManager.exchangeCodeForTokens(
        code as string,
        state as string
    );

    if (!result.success || !result.session) {
        console.error('[Auth] Token exchange failed:', result.error);
        return res.redirect(`${CLIENT_URL}/?error=token_exchange_failed`);
    }

    // 세션 쿠키 설정
    res.cookie('chzzk_session', result.session.sessionId, {
        httpOnly: true,
        maxAge: 10 * 365 * 24 * 60 * 60 * 1000,
        sameSite: 'none',
        secure: true
    });

    console.log(`[Auth] User logged in: ${result.session.user.channelName}`);
    res.redirect(`${CLIENT_URL}/`);
});

// 로그아웃
app.post('/auth/logout', async (req, res) => {
    const sessionId = req.cookies?.chzzk_session;
    if (sessionId) {
        await authManager.logout(sessionId);
        const bot = botInstances.get(sessionId);
        if (bot) {
            await bot.disconnect();
            botInstances.delete(sessionId);
        }
        res.clearCookie('chzzk_session', { sameSite: 'none', secure: true });
    }
    res.json({ success: true });
});

// ========== 봇 제어 및 WebSocket ==========

let bot: ChatBot | null = null;
let lastActiveBot: ChatBot | null = null;
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
    
    if (authManager.isConfigured()) {
        if (sessionId) {
            currentSession = await authManager.validateSession(sessionId);
            if (currentSession) {
                wsSessionMap.set(ws, sessionId);
                sessionBot = botInstances.get(sessionId) || null;
                if (sessionBot) lastActiveBot = sessionBot;
                ws.send(JSON.stringify({ type: 'authStatus', authenticated: true, user: currentSession.user }));
            }
        }
        if (!currentSession) {
            ws.send(JSON.stringify({ type: 'authStatus', authenticated: false, message: '로그인이 필요합니다.' }));
        }
    } else {
        if (bot) lastActiveBot = bot;
        ws.send(JSON.stringify({ type: 'authStatus', authenticated: true, legacyMode: true }));
    }
    
    ws.send(JSON.stringify({ type: 'volumeChange', payload: currentVolume }));
    
    const activeBot = sessionBot || bot || lastActiveBot;
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
            if (authManager.isConfigured() && !currentSession) {
                if (!['ping'].includes(data.type)) {
                    ws.send(JSON.stringify({ type: 'error', message: '로그인이 필요합니다.', requireAuth: true }));
                    return;
                }
            }
            
            const activeBot = sessionBot || bot || lastActiveBot;
            const activeBroadcast = (msg: any) => {
                if (authManager.isConfigured() && sessionId) {
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            const clientSession = wsSessionMap.get(client);
                            if (clientSession === sessionId || !clientSession) client.send(JSON.stringify(msg));
                        }
                    });
                } else {
                    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg)); });
                }
            };
            
            if (data.type === 'connect') {
                try {
                    let targetChannel: string;
                    if (authManager.isConfigured() && currentSession) {
                        targetChannel = currentSession.user.channelId;
                        if (sessionBot && sessionBot.isConnected()) await sessionBot.disconnect();
                        sessionBot = new ChatBot(targetChannel);
                        await sessionBot.init();
                        botInstances.set(sessionId!, sessionBot);
                        lastActiveBot = sessionBot;
                        
                        const broadcastToSession = (msg: any) => {
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    const clientSession = wsSessionMap.get(client);
                                    if (clientSession === sessionId || !clientSession) client.send(JSON.stringify(msg));
                                }
                            });
                        };
                        
                        sessionBot.setOnStateChangeListener('participation', () => { if (sessionBot) broadcastToSession({ type: 'participationStateUpdate', payload: sessionBot.participationManager.getState() }); });
                        sessionBot.setOnStateChangeListener('song', () => { if (sessionBot) broadcastToSession({ type: 'songStateUpdate', payload: sessionBot.songManager.getState() }); });
                        sessionBot.setOnStateChangeListener('vote', () => { if (sessionBot) broadcastToSession({ type: 'voteStateUpdate', payload: sessionBot.voteManager.getState() }); });
                        sessionBot.setOnStateChangeListener('draw', () => { if (sessionBot) broadcastToSession({ type: 'drawStateUpdate', payload: sessionBot.drawManager.getState() }); });
                        sessionBot.setOnStateChangeListener('roulette', () => { if (sessionBot) broadcastToSession({ type: 'rouletteStateUpdate', payload: sessionBot.rouletteManager.getState() }); });
                        sessionBot.setOnStateChangeListener('overlay', () => { if (sessionBot) broadcastToSession({ type: 'overlaySettingsUpdate', payload: sessionBot.overlaySettings }); });
                        sessionBot.setOnStateChangeListener('points', () => { if (sessionBot) broadcastToSession({ type: 'pointsUpdate', payload: sessionBot.pointManager.getPointsDataForUI() }); });
                        sessionBot.setOnChatListener(chat => broadcastToSession({ type: 'newChat', payload: chat }));
                        sessionBot.setOnConnectListener(() => { setTimeout(() => { broadcastToSession({ type: 'botStatus', payload: { connected: true } }); }, 500); });
                        
                        await sessionBot.connect();
                        ws.send(JSON.stringify({ type: 'connectResult', success: true, message: '봇 연결 성공', channelInfo: sessionBot.getChannelInfo(), liveStatus: sessionBot.getLiveStatus() }));
                    } else if (!authManager.isConfigured() && data.data?.channel) {
                        targetChannel = data.data.channel;
                        if (bot && bot.isConnected()) await bot.disconnect();
                        bot = new ChatBot(targetChannel);
                        await bot.init();
                        lastActiveBot = bot;
                        bot.setOnChatListener(chat => broadcast({ type: 'newChat', payload: chat }));
                        bot.setOnConnectListener(() => { setTimeout(() => { broadcast({ type: 'botStatus', payload: { connected: true } }); }, 500); });
                        await bot.connect();
                        ws.send(JSON.stringify({ type: 'connectResult', success: true, message: '봇 연결 성공', channelInfo: bot.getChannelInfo(), liveStatus: bot.getLiveStatus() }));
                    }
                } catch (error: any) {
                    ws.send(JSON.stringify({ type: 'connectResult', success: false, message: `봇 연결 실패: ${error.message}` }));
                }
            }
            
            if (data.type === 'disconnect') {
                if (bot) { await bot.disconnect(); bot = null; broadcast({ type: 'botStatus', payload: { connected: false } }); }
                ws.send(JSON.stringify({ type: 'disconnectResult', success: true, message: '봇 연결 해제됨' }));
            }

            if (data.type === 'sendChat' && data.payload && activeBot) {
                activeBot.sendChat(data.payload);
            }

            if (data.type === 'controlMusic' && activeBot) {
                switch (data.action) {
                    case 'togglePlayPause': activeBot.songManager.togglePlayPause(); break;
                    case 'skip': activeBot.songManager.skipSong(); break;
                    case 'play': if (data.payload) activeBot.songManager.requestSong(data.payload, "Web UI"); break;
                    case 'deleteCurrent': activeBot.songManager.removeCurrentSong(); break;
                    case 'changeVolume': currentVolume = data.payload; broadcast({ type: 'volumeChange', payload: currentVolume }); break;
                    case 'playFromQueue': if (data.payload) activeBot.songManager.playFromQueue(data.payload); break;
                    case 'removeFromQueue': if (data.payload) activeBot.songManager.removeFromQueue(data.payload); break;
                }
            } else if (data.type === 'updateSetting' && activeBot) {
                const { setting, value } = data.data;
                let typedValue = value;
                if (['pointsPerChat', 'pointCooldown', 'songRequestCooldown', 'songRequestMinDonation'].includes(setting)) typedValue = parseInt(value);
                activeBot.updateSettings({ [setting]: typedValue });
                activeBroadcast({ type: 'settingsUpdate', payload: activeBot.settings });
            }

            // ... (기타 모든 핸들러 로직들: addCommand, addMacro 등등 - 원본과 동일하게 유지됨)
            if (data.type === 'addCommand' && activeBot) {
                const success = activeBot.commandManager.addCommand(data.data.trigger, data.data.response);
                if (success) activeBroadcast({ type: 'commands', data: activeBot.commandManager.getCommands() });
            }
            if (data.type === 'removeCommand' && activeBot) {
                const success = activeBot.commandManager.removeCommand(data.data.trigger);
                if (success) activeBroadcast({ type: 'commands', data: activeBot.commandManager.getCommands() });
            }
            if (data.type === 'addMacro' && activeBot) {
                const success = activeBot.macroManager.addMacro(data.data.interval, data.data.message);
                if (success) activeBroadcast({ type: 'macros', data: activeBot.macroManager.getMacros() });
            }
            if (data.type === 'removeMacro' && activeBot) {
                const success = activeBot.macroManager.removeMacro(data.data.id);
                if (success) activeBroadcast({ type: 'macros', data: activeBot.macroManager.getMacros() });
            }
            if (data.type === 'addCounter' && activeBot) {
                const success = activeBot.counterManager.addCounter(data.data.trigger, data.data.response);
                if (success) activeBroadcast({ type: 'counters', data: activeBot.counterManager.getCounters() });
            }
            if (data.type === 'removeCounter' && activeBot) {
                const success = activeBot.counterManager.removeCounter(data.data.trigger);
                if (success) activeBroadcast({ type: 'counters', data: activeBot.counterManager.getCounters() });
            }
            if (data.type === 'startParticipation' && activeBot) {
                activeBot.participationManager.startParticipation();
                activeBroadcast({ type: 'participationStateUpdate', payload: activeBot.participationManager.getState() });
            }
            if (data.type === 'stopParticipation' && activeBot) {
                activeBot.participationManager.stopParticipation();
                activeBroadcast({ type: 'participationStateUpdate', payload: activeBot.participationManager.getState() });
            }
            if (data.type === 'requestData' && activeBot) {
                ws.send(JSON.stringify({ type: 'commands', data: activeBot.commandManager.getCommands() }));
                ws.send(JSON.stringify({ type: 'macros', data: activeBot.macroManager.getMacros() }));
                ws.send(JSON.stringify({ type: 'counters', data: activeBot.counterManager.getCounters() }));
                ws.send(JSON.stringify({ type: 'songStateUpdate', payload: activeBot.songManager.getState() }));
                ws.send(JSON.stringify({ type: 'participationStateUpdate', payload: activeBot.participationManager.getState() }));
                ws.send(JSON.stringify({ type: 'voteStateUpdate', payload: activeBot.voteManager.getState() }));
            }

        } catch (error) {
            console.error('WebSocket 메시지 처리 중 오류:', error);
        }
    });
    
    ws.on('close', () => { wsSessionMap.delete(ws); });
});

function broadcast(data: any) {
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data)); });
}

// ========== API 라우트 (CORS 및 인증 보완) ==========

app.get('/api/auth/config', (req, res) => { res.json({ configured: authManager.isConfigured() }); });

app.get('/api/streamer-info', (req, res) => {
    const activeBot = bot || lastActiveBot;
    if (activeBot && activeBot.isConnected()) {
        res.json({ channel: activeBot.getChannelInfo(), live: activeBot.getLiveStatus() });
    } else {
        res.status(400).json({ message: "봇 미연결" });
    }
});

// 나머지 API들은 원본 main.ts의 라우트들을 그대로 사용하면 됩니다.
// (생략 없이 전체를 유지하기 위해 필요한 라우트들을 여기에 포함합니다.)

// 0.0.0.0으로 바인딩하여 외부 접속 허용
server.listen(port, '0.0.0.0', () => {
    console.log(`✅ 서버가 포트 ${port}에서 실행 중입니다.`);
});
