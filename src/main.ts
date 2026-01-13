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

// [추가] 채널별 최근 채팅 기록 저장소 (최대 100개)
const channelChatHistory: Map<string, any[]> = new Map();

app.use(cors({ origin: [config.clientOrigin, "http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(cookieParser());

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
                
                // 봇 상태 변화 실시간 알림 연결
                bot.setOnStateChangeListener((type, payload) => broadcast(type, payload));
                
                // [개선] 봇 채팅 수신 시 기록 저장 및 전송
                bot.setOnChatListener((chat) => {
                    const history = channelChatHistory.get(channelId) || [];
                    history.push(chat);
                    if (history.length > 100) history.shift();
                    channelChatHistory.set(channelId, history);
                    broadcast('newChat', chat);
                });

                // [중요] 최초 연결 시 기존 채팅 기록 100개 통째로 전송
                const existingHistory = channelChatHistory.get(channelId) || [];
                ws.send(JSON.stringify({ type: 'chatHistoryLoad', payload: existingHistory }));

                ws.send(JSON.stringify({ 
                    type: 'connectResult', 
                    success: true, 
                    channelInfo: bot.getChannelInfo(),
                    liveStatus: bot.getLiveStatus()
                }));
                return;
            }

            if (!bot) return;

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

                // [중요] 모든 액션 후 자동 브로드캐스트 보장 (실시간 반영 해결)
                case 'updateSettings': bot.settings.updateSettings(data.data); break;
                case 'updateCommand': bot.commands.removeCommand(data.data.oldTrigger); bot.commands.addCommand(data.data.trigger, data.data.response); break;
                case 'addCommand': bot.commands.addCommand(data.data.trigger, data.data.response); break;
                case 'removeCommand': bot.commands.removeCommand(data.data.trigger); break;
                case 'toggleCommand': 
                    const targetCmd = bot.commands.getCommands().find(c => (c.triggers?.[0] || (c as any).trigger) === data.data.trigger);
                    if (targetCmd) { targetCmd.enabled = data.data.enabled; bot.saveAll(); broadcast('commandsUpdate', bot.commands.getCommands()); }
                    break;
                case 'addCounter': bot.counters.addCounter(data.data.trigger, data.data.response, data.data.oncePerDay); break;
                case 'removeCounter': bot.counters.removeCounter(data.data.trigger); break;
                case 'addMacro': bot.macros.addMacro(data.data.interval, data.data.message); break;
                case 'removeMacro': bot.macros.removeMacro(data.data.id); break;
                
                case 'toggleCounter':
                    const targetCnt = bot.counters.getCounters().find(c => c.trigger === data.data.trigger);
                    if (targetCnt) { targetCnt.enabled = data.data.enabled; bot.saveAll(); broadcast('countersUpdate', bot.counters.getCounters()); }
                    break;
                case 'toggleMacro':
                    const targetMac = bot.macros.getMacros().find(m => m.id === data.data.id);
                    if (targetMac) { targetMac.enabled = data.data.enabled; bot.saveAll(); broadcast('macrosUpdate', bot.macros.getMacros()); }
                    break;

                // (이하 투표/참여 로직 동일...)
                case 'startDraw': bot.draw.startSession(data.payload.keyword, data.payload.settings); break;
                case 'executeDraw': 
                    const winners = bot.draw.draw(data.payload.count);
                    if (winners.success) {
                        broadcast('drawWinnerResult', { winners: winners.winners });
                        winners.winners.forEach(w => DataManager.saveParticipationHistory(channelId, w.userIdHash, w.nickname));
                    }
                    break;
                case 'resetDraw': bot.draw.reset(); break;
                case 'createRoulette': bot.roulette.createRoulette(data.payload.items); break;
                case 'spinRoulette': 
                    const rWinner = bot.roulette.spin();
                    if (rWinner) broadcast('drawWinnerResult', { winners: [{ nickname: rWinner.text, userIdHash: 'roulette' }] });
                    break;
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
                case 'controlMusic':
                    if (data.action === 'skip') bot.songs.skipSong();
                    if (data.action === 'togglePlayPause') bot.songs.togglePlayPause();
                    break;
            }
        } catch (err) { console.error('[WS] System Error:', err); }
    });

    ws.on('close', () => clients.delete(ws));
});

server.listen(port, '0.0.0.0', () => console.log(`✅ System Running: Port ${port}`));