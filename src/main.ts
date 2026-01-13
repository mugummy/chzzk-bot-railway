// src/main.ts - Railway Server Version (Singleton Instance)

import { ChatBot } from './Bot';
import express from 'express';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
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

// 채널 ID별 봇 인스턴스 관리 (중복 방지)
const channelBotMap: Map<string, ChatBot> = new Map();
const wsSessionMap: Map<WebSocket, string> = new Map();

app.use(cors({
    origin: ["https://mugumchzzkbot.vercel.app", "http://localhost:3000"],
    credentials: true
}));

app.use(express.json());
app.use(cookieParser());

app.get('/api/auth/config', (req, res) => {
    res.json({ configured: authManager.isConfigured() });
});

app.get('/api/auth/session', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    // Authorization 헤더에서 토큰 추출 (Bearer <token>)
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    // 혹시 모르니 쿠키도 확인 (하위 호환)
    const sessionId = token || req.cookies?.chzzk_session;
    
    if (!sessionId) return res.json({ authenticated: false });

    const session = await authManager.validateSession(sessionId);
    if (!session) {
        return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, user: session.user });
});

app.get('/auth/login', (req, res) => {
    const { url } = authManager.generateAuthUrl('/');
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const CLIENT_URL = "https://mugumchzzkbot.vercel.app";
    if (error || !code || !state) return res.redirect(`${CLIENT_URL}/?error=oauth_failed`);

    const result = await authManager.exchangeCodeForTokens(code as string, state as string);
    if (!result.success || !result.session) return res.redirect(`${CLIENT_URL}/?error=token_exchange_failed`);

    // 쿠키 대신 URL 파라미터로 세션 ID 전달 (토큰 방식)
    const sessionId = result.session.sessionId;
    const channelName = encodeURIComponent(result.session.user.channelName);
    
    // 보안을 위해 1회성 토큰을 쓰는 게 좋지만, 여기선 편의상 세션 ID를 직접 전달
    res.redirect(`${CLIENT_URL}/dashboard.html?session=${sessionId}&channel=${channelName}`);
});

app.post('/auth/logout', async (req, res) => {
    const sessionId = req.cookies?.chzzk_session;
    if (sessionId) {
        const session = await authManager.validateSession(sessionId);
        if (session) {
            const bot = channelBotMap.get(session.user.channelId);
            if (bot) {
                await bot.disconnect();
                channelBotMap.delete(session.user.channelId);
            }
        }
        await authManager.logout(sessionId);
        res.clearCookie('chzzk_session', { sameSite: 'none', secure: true, path: '/' });
    }
    res.json({ success: true });
});

wss.on('connection', async (ws, req) => {
    // 1. URL 쿼리 파라미터에서 토큰 확인
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const tokenParam = url.searchParams.get('token');

    // 2. 쿠키에서 확인
    const cookieHeader = req.headers.cookie || '';
    const cookieSession = cookieHeader.split(';').find(c => c.trim().startsWith('chzzk_session='))?.split('=')[1];
    
    const sessionId = tokenParam || cookieSession;
    
    if (!sessionId) {
        ws.send(JSON.stringify({ type: 'error', message: '세션이 없습니다.', requireAuth: true }));
        return;
    }

    const currentSession = await authManager.validateSession(sessionId);
    if (!currentSession) {
        ws.send(JSON.stringify({ type: 'error', message: '인증이 만료되었습니다.', requireAuth: true }));
        return;
    }

    wsSessionMap.set(ws, sessionId);

    ws.on('message', async (message) => {
        const data = JSON.parse(message.toString());
        
        // 봇 연결 요청 시 중복 체크 로직 강화
        if (data.type === 'connect') {
            const channelId = currentSession.user.channelId;
            let activeBot = channelBotMap.get(channelId);

            if (activeBot) {
                console.log(`[Server] Existing bot found for channel: ${channelId}`);
                if (!activeBot.isConnected()) {
                    console.log(`[Server] Bot disconnected, reconnecting...`);
                    await activeBot.connect();
                }
            } else {
                console.log(`[Server] Creating new bot instance for channel: ${channelId}`);
                activeBot = new ChatBot(channelId);
                channelBotMap.set(channelId, activeBot); // 맵에 먼저 등록 (중복 방지)
                await activeBot.init();
                await activeBot.connect();
            }

            // 클라이언트에 연결 성공 응답 전송
            ws.send(JSON.stringify({ 
                type: 'connectResult', 
                success: true, 
                channelInfo: activeBot.getChannelInfo(),
                liveStatus: activeBot.getLiveStatus()
            }));
            
            // 현재 설정 상태도 바로 전송 (동기화)
            ws.send(JSON.stringify({
                type: 'settingsUpdate',
                payload: activeBot.settings
            }));

            // ===== 상태 변경 리스너 연결 (UI 동기화 핵심) =====
            const broadcast = (msg: any) => ws.send(JSON.stringify(msg));

            activeBot.setOnStateChangeListener('vote', () => {
                broadcast({ type: 'voteStateUpdate', payload: activeBot.voteManager.getState() });
            });
            activeBot.setOnStateChangeListener('draw', () => {
                broadcast({ type: 'drawStateUpdate', payload: activeBot.drawManager.getState() });
            });
            activeBot.setOnStateChangeListener('roulette', () => {
                broadcast({ type: 'rouletteStateUpdate', payload: activeBot.rouletteManager.getState() });
            });
            activeBot.setOnStateChangeListener('song', () => {
                broadcast({ type: 'songStateUpdate', payload: activeBot.songManager.getState() });
            });
            activeBot.setOnStateChangeListener('participation', () => {
                broadcast({ type: 'participationStateUpdate', payload: activeBot.participationManager.getState() });
            });
            activeBot.setOnStateChangeListener('points', () => {
                broadcast({ type: 'pointsUpdate', payload: activeBot.pointManager.getPointsData() });
            });
            activeBot.setOnStateChangeListener('overlay', () => {
                broadcast({ type: 'overlaySettingsUpdate', payload: activeBot.overlaySettings });
            });
            
            // 초기 상태 전송
            broadcast({ type: 'voteStateUpdate', payload: activeBot.voteManager.getState() });
            broadcast({ type: 'drawStateUpdate', payload: activeBot.drawManager.getState() });
            broadcast({ type: 'rouletteStateUpdate', payload: activeBot.rouletteManager.getState() });
            broadcast({ type: 'songStateUpdate', payload: activeBot.songManager.getState() });
            broadcast({ type: 'participationStateUpdate', payload: activeBot.participationManager.getState() });
        }
        
        // (그 외 데이터 요청 및 봇 제어 핸들러들은 activeBot을 channelBotMap에서 꺼내서 처리)
        const activeBot = channelBotMap.get(currentSession.user.channelId);
        if (!activeBot) return;

        // ... (기타 모든 핸들러 로직들 동일)
    });

    ws.on('close', () => { wsSessionMap.delete(ws); });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`✅ 서버 실행 중 (포트: ${port})`);
});
