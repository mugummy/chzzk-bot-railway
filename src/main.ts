import express from 'express';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from './config';
import { AuthManager } from './AuthManager';
import { BotManager } from './BotManager';

/**
 * Main System Hub: Express + WebSocket Server
 * 모든 클라이언트와의 실시간 통신 및 인증을 제어합니다.
 */
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = parseInt(process.env.PORT || '8080', 10);
const authManager = new AuthManager(config.chzzk.clientId, config.chzzk.clientSecret, config.chzzk.redirectUri);
const botManager = BotManager.getInstance();

// 1. 미들웨어 설정
app.use(cors({ origin: [config.clientOrigin, "http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(cookieParser());

// 2. HTTP 인증 엔드포인트
app.get('/api/auth/session', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.chzzk_session;
    if (!token) return res.json({ authenticated: false });
    const session = await authManager.validateSession(token);
    res.json({ authenticated: !!session, user: session?.user || null });
});

app.get('/auth/login', (req, res) => res.redirect(authManager.generateAuthUrl('/').url));

app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const result = await authManager.exchangeCodeForTokens(code as string, state as string);
    if (!result.success || !result.session) {
        return res.redirect(`${config.clientOrigin}/?error=auth`);
    }
    // 성공 시 대시보드로 이동 (토큰 포함)
    res.redirect(`${config.clientOrigin}/dashboard?session=${result.session.sessionId}`);
});

// 3. 실시간 WebSocket 허브
// 채널별 클라이언트 추적을 위한 맵
const channelClientsMap: Map<string, Set<WebSocket>> = new Map();

wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    // 세션 검증
    const session = token ? await authManager.validateSession(token) : null;
    if (!session) {
        console.warn(`[WS] Connection rejected: Invalid Token`);
        return ws.close();
    }

    const channelId = session.user.channelId;
    if (!channelClientsMap.has(channelId)) channelClientsMap.set(channelId, new Set());
    const clients = channelClientsMap.get(channelId)!;
    clients.add(ws);

    console.log(`[WS] Dashboard connected for channel: ${session.user.channelName} (${channelId})`);

    // 해당 채널의 봇 브로드캐스트 헬퍼
    const broadcast = (type: string, payload: any) => {
        const msg = JSON.stringify({ type, payload });
        clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN) c.send(msg);
        });
    };

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            let bot = botManager.getBot(channelId);

            // 봇 연결 요청 처리
            if (data.type === 'connect') {
                bot = await botManager.getOrCreateBot(channelId);
                
                // 봇 상태 변경 시 모든 대시보드 클라이언트에 자동 브로드캐스트 연결
                bot.setOnStateChangeListener((type, payload) => broadcast(type, payload));
                
                ws.send(JSON.stringify({ 
                    type: 'connectResult', 
                    success: true, 
                    channelInfo: { 
                        channelId: bot.getChannelId(),
                        channelName: session.user.channelName,
                        channelImageUrl: session.user.channelImageUrl
                    }
                }));
                return;
            }

            if (!bot) return;

            // 각 매니저로 액션 라우팅
            switch (data.type) {
                case 'requestData':
                    // 현재 모든 데이터 강제 동기화 요청
                    ws.send(JSON.stringify({ type: 'settingsUpdate', payload: bot.settings.getSettings() }));
                    ws.send(JSON.stringify({ type: 'commandsUpdate', payload: bot.commands.getCommands() }));
                    ws.send(JSON.stringify({ type: 'countersUpdate', payload: bot.counters.getCounters() }));
                    ws.send(JSON.stringify({ type: 'macrosUpdate', payload: bot.macros.getMacros() }));
                    ws.send(JSON.stringify({ type: 'songStateUpdate', payload: bot.songs.getState() }));
                    ws.send(JSON.stringify({ type: 'voteStateUpdate', payload: bot.votes.getState() }));
                    ws.send(JSON.stringify({ type: 'participationStateUpdate', payload: bot.participation.getState() }));
                    ws.send(JSON.stringify({ type: 'greetStateUpdate', payload: bot.greet.getState() }));
                    break;

                case 'updateSettings': bot.settings.updateSettings(data.data); break;
                case 'addCommand': bot.commands.addCommand(data.data.trigger, data.data.response); break;
                case 'removeCommand': bot.commands.removeCommand(data.data.trigger); break;
                case 'addCounter': bot.counters.addCounter(data.data.trigger, data.data.response, data.data.oncePerDay); break;
                case 'removeCounter': bot.counters.removeCounter(data.data.trigger); break;
                case 'updateGreetSettings': bot.greet.updateSettings(data.data); break;
                case 'resetGreetHistory': bot.greet.clearHistory(); break;
                
                // 투표 및 기타 액션...
                case 'createVote': bot.votes.createVote(data.data.question, data.data.options, data.data.settings); break;
                case 'startVote': bot.votes.startVote(); break;
                case 'endVote': bot.votes.endVote(); break;
                case 'resetVote': bot.votes.resetVote(); break;

                // 노래 제어
                case 'controlMusic':
                    if (data.action === 'skip') bot.songs.skipSong();
                    if (data.action === 'togglePlayPause') bot.songs.togglePlayPause();
                    break;
            }
        } catch (err) {
            console.error('[WS] Message Processing Error:', err);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`[WS] Client disconnected for channel: ${channelId}`);
    });
});

// 4. 서버 기동
server.listen(port, '0.0.0.0', () => {
    console.log(`
    =========================================
    🚀 PRO BOT SYSTEM ONLINE
    📍 Port: ${port}
    🌐 Client: ${config.clientOrigin}
    =========================================
    `);
});

// 프로세스 종료 시 안전하게 정리
process.on('SIGTERM', () => botManager.shutdownAll());
process.on('SIGINT', () => botManager.shutdownAll());