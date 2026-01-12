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

// Railway에서 제공하는 PORT 환경변수 사용
const port = parseInt(process.env.PORT || '8080', 10);

console.log('[System] Server starting...');
console.log(`[Config] Client ID exists: ${!!config.chzzk.clientId}`);
console.log(`[Config] Client Secret exists: ${!!config.chzzk.clientSecret}`);
console.log(`[Config] Redirect URI: ${config.chzzk.redirectUri}`);

// 인증 매니저 초기화
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

// Root route
app.get('/', (req, res) => {
    res.send(`Chzzk Bot Server is running on port ${port}`);
});

// ========== OAuth 인증 라우트 ==========

app.get('/api/auth/config', (req, res) => {
    res.json({
        configured: authManager.isConfigured()
    });
});

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

    res.cookie('chzzk_session', result.session.sessionId, {
        httpOnly: true,
        maxAge: 10 * 365 * 24 * 60 * 60 * 1000,
        sameSite: 'none',
        secure: true
    });

    console.log(`[Auth] User logged in: ${result.session.user.channelName}`);
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
        res.clearCookie('chzzk_session', { sameSite: 'none', secure: true });
    }
    res.json({ success: true });
});

// ========== 봇 제어 및 WebSocket ==========

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
    
    // 오직 OAuth 인증만 허용 (레거시 모드 삭제됨)
    if (authManager.isConfigured()) {
        if (sessionId) {
            currentSession = await authManager.validateSession(sessionId);
            if (currentSession) {
                wsSessionMap.set(ws, sessionId);
                sessionBot = botInstances.get(sessionId) || null;
                ws.send(JSON.stringify({ type: 'authStatus', authenticated: true, user: currentSession.user }));
            }
        }
        if (!currentSession) {
            ws.send(JSON.stringify({ type: 'authStatus', authenticated: false, message: '로그인이 필요합니다.' }));
        }
    } else {
        // 설정이 없으면 에러 전송
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: '서버 OAuth 설정이 완료되지 않았습니다.',
            requireAuth: true 
        }));
    }
    
    ws.send(JSON.stringify({ type: 'volumeChange', payload: currentVolume }));
    
    // 세션 봇이 있을 때만 데이터 전송
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
            
            // 인증 필수
            if (!currentSession) {
                if (!['ping'].includes(data.type)) {
                    ws.send(JSON.stringify({ type: 'error', message: '로그인이 필요합니다.', requireAuth: true }));
                    return;
                }
            }
            
            const activeBot = sessionBot;
            
            // 봇이 없으면(연결 전) 명령 무시
            if (!activeBot && data.type !== 'connect') {
                 return;
            }

            const activeBroadcast = (msg: any) => {
                if (sessionId) {
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            const clientSession = wsSessionMap.get(client);
                            if (clientSession === sessionId || !clientSession) client.send(JSON.stringify(msg));
                        }
                    });
                }
            };
            
            if (data.type === 'connect') {
                try {
                    if (currentSession) {
                        const targetChannel = currentSession.user.channelId;
                        if (sessionBot && sessionBot.isConnected()) await sessionBot.disconnect();
                        
                        sessionBot = new ChatBot(targetChannel);
                        await sessionBot.init();
                        botInstances.set(sessionId!, sessionBot);
                        
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
                    } 
                } catch (error: any) {
                    ws.send(JSON.stringify({ type: 'connectResult', success: false, message: `봇 연결 실패: ${error.message}` }));
                }
            }
            
            if (data.type === 'disconnect') {
                if (activeBot) { await activeBot.disconnect(); botInstances.delete(sessionId!); }
                ws.send(JSON.stringify({ type: 'disconnectResult', success: true, message: '봇 연결 해제됨' }));
            }

            if (activeBot) {
                if (data.type === 'sendChat' && data.payload) {
                    activeBot.sendChat(data.payload);
                }

                if (data.type === 'controlMusic') {
                    switch (data.action) {
                        case 'togglePlayPause': activeBot.songManager.togglePlayPause(); break;
                        case 'skip': activeBot.songManager.skipSong(); break;
                        case 'play': if (data.payload) activeBot.songManager.requestSong(data.payload, "Web UI"); break;
                        case 'deleteCurrent': activeBot.songManager.removeCurrentSong(); break;
                        case 'changeVolume': currentVolume = data.payload; activeBroadcast({ type: 'volumeChange', payload: currentVolume }); break;
                        case 'playFromQueue': if (data.payload) activeBot.songManager.playFromQueue(data.payload); break;
                        case 'removeFromQueue': if (data.payload) activeBot.songManager.removeFromQueue(data.payload); break;
                    }
                } else if (data.type === 'updateSetting') {
                    const { setting, value } = data.data;
                    let typedValue = value;
                    if (['pointsPerChat', 'pointCooldown', 'songRequestCooldown', 'songRequestMinDonation'].includes(setting)) typedValue = parseInt(value);
                    activeBot.updateSettings({ [setting]: typedValue });
                    activeBroadcast({ type: 'settingsUpdate', payload: activeBot.settings });
                }

                if (data.type === 'addCommand') {
                    const success = activeBot.commandManager.addCommand(data.data.trigger, data.data.response);
                    if (success) activeBroadcast({ type: 'commands', data: activeBot.commandManager.getCommands() });
                }
                if (data.type === 'removeCommand') {
                    const success = activeBot.commandManager.removeCommand(data.data.trigger);
                    if (success) activeBroadcast({ type: 'commands', data: activeBot.commandManager.getCommands() });
                }
                if (data.type === 'updateCommand') {
                    // ... (이전과 동일)
                    const commands = activeBot.commandManager.getCommands();
                    const oldCommand = commands.find(c => {
                        const triggers = c.triggers || (c.trigger ? [c.trigger] : []);
                        return triggers.includes(data.data.oldTrigger);
                    });
                    
                    if (oldCommand) {
                        const triggers = oldCommand.triggers || (oldCommand.trigger ? [oldCommand.trigger] : []);
                        const oldTrigger = triggers[0]; 
                        
                        if (oldTrigger) {
                            const success = activeBot.commandManager.updateCommand(
                                oldTrigger,
                                data.data.newTrigger,
                                data.data.response,
                                data.data.enabled
                            );
                            if (success) activeBroadcast({ type: 'commands', data: activeBot.commandManager.getCommands() });
                        }
                    }
                }
                if (data.type === 'addMacro') {
                    const success = activeBot.macroManager.addMacro(data.data.interval, data.data.message);
                    if (success) activeBroadcast({ type: 'macros', data: activeBot.macroManager.getMacros() });
                }
                if (data.type === 'removeMacro') {
                    const success = activeBot.macroManager.removeMacro(data.data.id);
                    if (success) activeBroadcast({ type: 'macros', data: activeBot.macroManager.getMacros() });
                }
                if (data.type === 'updateMacro') {
                    const success = activeBot.macroManager.updateMacro(parseInt(data.data.id), data.data.message, data.data.interval, true);
                    if (success) activeBroadcast({ type: 'macros', data: activeBot.macroManager.getMacros() });
                }
                if (data.type === 'addCounter') {
                    const success = activeBot.counterManager.addCounter(data.data.trigger, data.data.response);
                    if (success) activeBroadcast({ type: 'counters', data: activeBot.counterManager.getCounters() });
                }
                if (data.type === 'removeCounter') {
                    const success = activeBot.counterManager.removeCounter(data.data.trigger);
                    if (success) activeBroadcast({ type: 'counters', data: activeBot.counterManager.getCounters() });
                }
                if (data.type === 'updateCounter') {
                    // ... (이전과 동일)
                    const counters = activeBot.counterManager.getCounters();
                    const oldCounter = counters.find(c => c.trigger === data.data.oldTrigger);
                    
                    if (oldCounter) {
                        const success = activeBot.counterManager.updateCounter(
                            data.data.oldTrigger,
                            data.data.newTrigger,
                            data.data.response,
                            data.data.enabled
                        );
                        if (success) activeBroadcast({ type: 'counters', data: activeBot.counterManager.getCounters() });
                    }
                }
                if (data.type === 'updateSongSetting') {
                    const { setting, value } = data.data;
                    activeBot.songManager.updateSetting(setting, value);
                    activeBroadcast({ type: 'songSettingUpdate', data: { setting, value } });
                }
                if (data.type === 'startParticipation') {
                    activeBot.participationManager.startParticipation();
                    activeBroadcast({ type: 'participationStateUpdate', payload: activeBot.participationManager.getState() });
                }
                if (data.type === 'stopParticipation') {
                    activeBot.participationManager.stopParticipation();
                    activeBroadcast({ type: 'participationStateUpdate', payload: activeBot.participationManager.getState() });
                }
                // ... 나머지 투표, 추첨, 룰렛 등 핸들러들은 activeBot 객체를 사용하여 동일하게 유지
                if (data.type === 'createVote') {
                    const { question, options, durationSeconds } = data.data;
                    const result = activeBot.voteManager.createVote(question, options, durationSeconds);
                    if (result.success) {
                        const voteState = activeBot.voteManager.getState();
                        activeBroadcast({ type: 'voteStateUpdate', payload: voteState });
                        activeBroadcast({ type: 'overlayShow', payload: { screen: 'vote', data: { currentVote: voteState.currentVote } } });
                    }
                }
                if (data.type === 'startVote') {
                    const result = activeBot.voteManager.startVote();
                    if (result.success) {
                        const voteState = activeBot.voteManager.getState();
                        activeBroadcast({ type: 'voteStateUpdate', payload: voteState });
                        activeBroadcast({ type: 'overlayShow', payload: { screen: 'vote', data: { currentVote: voteState.currentVote } } });
                    }
                }
                if (data.type === 'endVote') {
                    const result = activeBot.voteManager.endVote();
                    if (result.success) activeBroadcast({ type: 'voteStateUpdate', payload: activeBot.voteManager.getState() });
                }
                if (data.type === 'requestData') {
                    ws.send(JSON.stringify({ type: 'commands', data: activeBot.commandManager.getCommands() }));
                    ws.send(JSON.stringify({ type: 'macros', data: activeBot.macroManager.getMacros() }));
                    ws.send(JSON.stringify({ type: 'counters', data: activeBot.counterManager.getCounters() }));
                    ws.send(JSON.stringify({ type: 'songStateUpdate', payload: activeBot.songManager.getState() }));
                    ws.send(JSON.stringify({ type: 'participationStateUpdate', payload: activeBot.participationManager.getState() }));
                    ws.send(JSON.stringify({ type: 'voteStateUpdate', payload: activeBot.voteManager.getState() }));
                }
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

// ========== API 라우트 ==========

app.get('/api/auth/config', (req, res) => { res.json({ configured: authManager.isConfigured() }); });

app.get('/api/streamer-info', (req, res) => {
    // 세션 없이 접근 시 401 반환 (혹은 예외 처리)
    res.status(401).json({ message: "인증 필요" });
});

// 외부 접속 허용
server.listen(port, '0.0.0.0', () => {
    console.log(`✅ 서버가 포트 ${port}에서 실행 중입니다.`);
});