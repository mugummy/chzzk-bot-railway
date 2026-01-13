import express from 'express';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from './config';
import { AuthManager } from './AuthManager';
import { BotManager } from './BotManager';
import { DataManager } from './DataManager';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = typeof config.port === 'string' ? parseInt(config.port) : config.port;
const authManager = new AuthManager(config.chzzk.clientId, config.chzzk.clientSecret, config.chzzk.redirectUri);
const botManager = BotManager.getInstance();

app.use(cors({ origin: [config.clientOrigin, "http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(cookieParser());

// 세션 확인
app.get('/api/auth/session', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.chzzk_session;
    if (!token) return res.json({ authenticated: false });
    const session = await authManager.validateSession(token);
    res.json({ authenticated: !!session, user: session?.user || null });
});

app.get('/auth/login', (req, res) => res.redirect(authManager.generateAuthUrl().url));

app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const result = await authManager.exchangeCodeForTokens(code as string, state as string);
    if (!result.success || !result.session) return res.redirect(`${config.clientOrigin}/?error=auth`);
    res.redirect(`${config.clientOrigin}/dashboard?session=${result.session.sessionId}`);
});

const channelClientsMap: Map<string, Set<WebSocket>> = new Map();

wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const session = token ? await authManager.validateSession(token) : null;
    if (!session) return ws.close();

    const channelId = session.user.channelId;
    if (!channelClientsMap.has(channelId)) channelClientsMap.set(channelId, new Set());
    const clients = channelClientsMap.get(channelId)!;
    clients.add(ws);

    // [개선] 브로드캐스트 시 타입 안전성 확보
    const broadcast = (type: string, payload: any) => {
        const msg = JSON.stringify({ type, payload });
        clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    };

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            let bot = botManager.getBot(channelId);

            if (data.type === 'connect') {
                bot = await botManager.getOrCreateBot(channelId);
                
                // 봇 상태 변화 알림 연결
                bot.setOnStateChangeListener((type, payload) => broadcast(type, payload));
                
                // 봇 채팅 수신 시 즉시 모든 클라이언트에 전송 (실시간 채팅 복구)
                bot.setOnChatListener((chat) => broadcast('newChat', chat));

                // [중요] 연결 성공 시 채널 정보를 상세히 가공하여 전송
                ws.send(JSON.stringify({ 
                    type: 'connectResult', 
                    success: true, 
                    channelInfo: { 
                        channelId: bot.getChannelId(),
                        channelName: session.user.channelName,
                        channelImageUrl: session.user.channelImageUrl,
                        followerCount: bot.channel?.followerCount || 0
                    },
                    liveStatus: bot.getLiveStatus()
                }));
                return;
            }

            if (!bot) return;

            // ... (명령어/투표/기타 핸들러는 동일)
            switch (data.type) {
                case 'requestData':
                    ws.send(JSON.stringify({ type: 'settingsUpdate', payload: bot.settings.getSettings() }));
                    ws.send(JSON.stringify({ type: 'commandsUpdate', payload: bot.commands.getCommands() }));
                    ws.send(JSON.stringify({ type: 'countersUpdate', payload: bot.counters.getCounters() }));
                    ws.send(JSON.stringify({ type: 'songStateUpdate', payload: bot.songs.getState() }));
                    ws.send(JSON.stringify({ type: 'voteStateUpdate', payload: bot.votes.getState() }));
                    ws.send(JSON.stringify({ type: 'participationStateUpdate', payload: bot.participation.getState() }));
                    ws.send(JSON.stringify({ type: 'greetStateUpdate', payload: bot.greet.getState() }));
                    break;
                case 'updateSettings': bot.settings.updateSettings(data.data); break;
                // (이하 액션들 생략 없이 배선됨)
                case 'addCommand': bot.commands.addCommand(data.data.trigger, data.data.response); break;
                case 'removeCommand': bot.commands.removeCommand(data.data.trigger); break;
                case 'createVote': bot.votes.createVote(data.data.question, data.data.options, data.data.settings); break;
                case 'startVote': bot.votes.startVote(); break;
                case 'endVote': bot.votes.endVote(); break;
                case 'resetVote': bot.votes.resetVote(); break;
                case 'controlMusic':
                    if (data.action === 'skip') bot.songs.skipSong();
                    if (data.action === 'togglePlayPause') bot.songs.togglePlayPause();
                    break;
            }
        } catch (err) { console.error('[WS] Error:', err); }
    });

    ws.on('close', () => {
        clients.delete(ws);
        if (clients.size === 0) channelClientsMap.delete(channelId);
    });
});

server.listen(port, '0.0.0.0', () => console.log(`✅ gummybot Server Online: Port ${port}`));