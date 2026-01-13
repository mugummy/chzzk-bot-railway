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
                
                // 상태 변경 감지 시 자동 저장 및 전파
                bot.setOnStateChangeListener((type, payload) => {
                    bot?.saveAll(); // [중요] 상태 변경 시 즉시 DB 저장
                    broadcast(type, payload);
                });
                
                bot.setOnChatListener((chat) => broadcast('newChat', chat));

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

                // [수정] 모든 변경 액션 후 즉시 저장 및 브로드캐스트 호출
                case 'updateSettings': 
                    bot.settings.updateSettings(data.data); 
                    break; // setOnStateChangeListener에서 처리됨

                case 'addCommand': 
                    bot.commands.addCommand(data.data.trigger, data.data.response); 
                    break;
                case 'removeCommand': 
                    bot.commands.removeCommand(data.data.trigger); 
                    break;
                case 'updateCommand':
                    bot.commands.removeCommand(data.data.oldTrigger);
                    bot.commands.addCommand(data.data.trigger, data.data.response);
                    break;

                case 'addCounter': bot.counters.addCounter(data.data.trigger, data.data.response, data.data.oncePerDay); break;
                case 'removeCounter': bot.counters.removeCounter(data.data.trigger); break;
                
                case 'addMacro': bot.macros.addMacro(data.data.interval, data.data.message); break;
                case 'removeMacro': bot.macros.removeMacro(data.data.id); break;

                case 'toggleCommand': 
                    const tCmd = bot.commands.getCommands().find(c => (c.triggers?.[0] || (c as any).trigger) === data.data.trigger);
                    if (tCmd) { 
                        tCmd.enabled = data.data.enabled; 
                        bot.saveAll(); 
                        broadcast('commandsUpdate', bot.commands.getCommands()); 
                    }
                    break;
                
                case 'toggleCounter':
                    const tCnt = bot.counters.getCounters().find(c => c.trigger === data.data.trigger);
                    if (tCnt) { 
                        tCnt.enabled = data.data.enabled; 
                        bot.saveAll(); 
                        broadcast('countersUpdate', bot.counters.getCounters()); 
                    }
                    break;

                case 'toggleMacro':
                    const tMac = bot.macros.getMacros().find(m => m.id === data.data.id);
                    if (tMac) { 
                        tMac.enabled = data.data.enabled; 
                        bot.saveAll(); 
                        broadcast('macrosUpdate', bot.macros.getMacros()); 
                    }
                    break;

                // 투표/참여 등 나머지 로직은 BotInstance 내부 notify를 통해 자동 처리됨
                case 'startDraw': bot.draw.startSession(data.payload.keyword, data.payload.settings); break;
                case 'executeDraw': 
                    const winners = bot.draw.draw(data.payload.count);
                    if (winners.success) broadcast('drawWinnerResult', { winners: winners.winners });
                    break;
                case 'resetDraw': bot.draw.reset(); break;
                case 'createRoulette': bot.roulette.createRoulette(data.payload.items); break;
                case 'spinRoulette': 
                    const rWinner = bot.roulette.spin();
                    if (rWinner) broadcast('drawWinnerResult', { winners: [{ nickname: rWinner.text, userIdHash: 'roulette' }] });
                    break;
                case 'resetRoulette': bot.roulette.reset(); break;
                case 'createVote': bot.votes.createVote(data.data.question, data.data.options, data.data.settings); break;
                case 'startVote': bot.votes.startVote(); break;
                case 'endVote': bot.votes.endVote(); break;
                case 'resetVote': bot.votes.resetVote(); break;
                case 'toggleParticipation': bot.participation.getState().isParticipationActive ? bot.participation.stopParticipation() : bot.participation.startParticipation(); break;
                case 'moveToParticipants': bot.participation.moveToParticipants(data.data.userIdHash); break;
                case 'removeParticipant': bot.participation.removeUser(data.data.userIdHash); break;
                case 'clearParticipants': bot.participation.clearAllData(); break;
                case 'updateGreetSettings': bot.greet.updateSettings(data.data); break;
                case 'resetGreetHistory': bot.greet.clearHistory(); break;
                case 'controlMusic':
                    if (data.action === 'skip') bot.songs.skipSong();
                    if (data.action === 'togglePlayPause') bot.songs.togglePlayPause();
                    break;
            }
        } catch (err) { console.error('[WS] Hub Error:', err); }
    });

    ws.on('close', () => {
        clients.delete(ws);
        if (clients.size === 0) channelClientsMap.delete(channelId);
    });
});

server.listen(port, '0.0.0.0', () => console.log(`✅ gummybot Server Online: Port ${port}`));
