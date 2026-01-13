import express from 'express';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from './config';
import { AuthManager } from './AuthManager';
import { BotManager } from './BotManager';

/**
 * Main Server Hub: 모든 실시간 데이터 흐름을 통제합니다.
 */
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = parseInt(process.env.PORT || '8080', 10);
const authManager = new AuthManager(config.chzzk.clientId, config.chzzk.clientSecret, config.chzzk.redirectUri);
const botManager = BotManager.getInstance();

app.use(cors({ origin: [config.clientOrigin, "http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(cookieParser());

// 인증 체크 엔드포인트
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
                bot.setOnStateChangeListener((type, payload) => broadcast(type, payload));
                ws.send(JSON.stringify({ 
                    type: 'connectResult', 
                    success: true, 
                    channelInfo: { channelId, channelName: session.user.channelName, channelImageUrl: session.user.channelImageUrl }
                }));
                return;
            }

            if (!bot) return;

            // [핵심] 대시보드 액션과 서버 매니저 메서드 1:1 매칭
            switch (data.type) {
                case 'requestData':
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
                case 'addMacro': bot.macros.addMacro(data.data.interval, data.data.message); break;
                case 'removeMacro': bot.macros.removeMacro(data.data.id); break;
                case 'toggleParticipation': bot.participation.getState().isParticipationActive ? bot.participation.stopParticipation() : bot.participation.startParticipation(); break;
                case 'moveToParticipants': bot.participation.moveToParticipants(data.data.userIdHash); break;
                case 'removeParticipant': bot.participation.removeUser(data.data.userIdHash); break;
                case 'clearParticipants': bot.participation.clearAllData(); break;
                case 'updateGreetSettings': bot.greet.updateSettings(data.data); break;
                case 'resetGreetHistory': bot.greet.clearHistory(); break;
                case 'createVote': bot.votes.createVote(data.data.question, data.data.options, data.data.settings); break;
                case 'startVote': bot.votes.startVote(); break;
                case 'endVote': bot.votes.endVote(); break;
                case 'resetVote': bot.votes.resetVote(); break;
                case 'createRoulette': bot.roulette.createRoulette(data.payload.items); break; // 보정: createRoulette 메서드명 일치
                case 'spinRoulette': bot.roulette.spin(); break;
                case 'controlMusic':
                    if (data.action === 'skip') bot.songs.skipSong();
                    if (data.action === 'togglePlayPause') bot.songs.togglePlayPause();
                    break;
            }
        } catch (err) { console.error('[WS] System Processing Error:', err); }
    });

    ws.on('close', () => clients.delete(ws));
});

server.listen(port, '0.0.0.0', () => console.log(`🚀 System Online: Port ${port}`));