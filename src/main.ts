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

const channelChatHistory: Map<string, any[]> = new Map();

app.use(cors({ origin: [config.clientOrigin, "http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(cookieParser());

botManager.initializeAllBots().then(() => console.log('✅ All Bots Pre-loaded (Features Removed)'));

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

    const sendFullState = async (bot: any) => {
        if (!bot) return;
        try { await bot.refreshLiveInfo(); } catch(e) {}
        ws.send(JSON.stringify({ type: 'connectResult', success: true, channelInfo: bot.getChannelInfo(), liveStatus: bot.getLiveStatus() }));
        ws.send(JSON.stringify({ type: 'settingsUpdate', payload: bot.settings.getSettings() }));
        ws.send(JSON.stringify({ type: 'commandsUpdate', payload: bot.commands.getCommands() }));
        ws.send(JSON.stringify({ type: 'countersUpdate', payload: bot.counters.getCounters() }));
        ws.send(JSON.stringify({ type: 'macrosUpdate', payload: bot.macros.getMacros() }));
        ws.send(JSON.stringify({ type: 'songStateUpdate', payload: bot.songs.getState() }));
        ws.send(JSON.stringify({ type: 'participationStateUpdate', payload: bot.participation.getState() }));
        ws.send(JSON.stringify({ type: 'greetStateUpdate', payload: bot.greet.getState() }));
        
        // [New Features State]
        ws.send(JSON.stringify({ type: 'voteStateUpdate', payload: bot.vote.getState() }));
        ws.send(JSON.stringify({ type: 'drawStateUpdate', payload: bot.draw.getState() }));
        ws.send(JSON.stringify({ type: 'rouletteStateUpdate', payload: bot.roulette.getState() }));
        ws.send(JSON.stringify({ type: 'overlayStateUpdate', payload: bot.overlayManager.getState() }));

        ws.send(JSON.stringify({ type: 'chatHistoryLoad', payload: channelChatHistory.get(channelId) || [] }));
        try {
            const ranking = await DataManager.loadParticipationHistory(channelId);
            ws.send(JSON.stringify({ type: 'participationRankingUpdate', payload: ranking }));
        } catch (e) {}
    };

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            let bot = botManager.getBot(channelId);

            if (data.type === 'connect') {
                if (!bot) bot = await botManager.getOrCreateBot(channelId);
                
                // BotInstance가 broadcast를 직접 할 수 있도록 콜백 연결
                bot.setBroadcastCallback(broadcast);

                bot.setOnStateChangeListener((type, payload) => { bot?.saveAll(); broadcast(type, payload); });
                bot.setOnChatListener((chat) => {
                    const history = channelChatHistory.get(channelId) || [];
                    history.push(chat); if (history.length > 100) history.shift();
                    channelChatHistory.set(channelId, history);
                    broadcast('newChat', chat);
                });
                await sendFullState(bot);
                return;
            }

            if (!bot) return;

            switch (data.type) {
                case 'requestData': await sendFullState(bot); break;
                case 'updateSettings': bot.settings.updateSettings(data.data); break;
                
                case 'addCommand': bot.commands.addCommand(data.data.trigger, data.data.response); break;
                case 'removeCommand': bot.commands.removeCommand(data.data.trigger); break;
                case 'updateCommand': bot.commands.removeCommand(data.data.oldTrigger); bot.commands.addCommand(data.data.trigger, data.data.response); break;
                case 'toggleCommand': 
                    const tCmd = bot.commands.getCommands().find(c => (c.triggers?.[0] || (c as any).trigger) === data.data.trigger);
                    if (tCmd) { tCmd.enabled = data.data.enabled; bot.saveAll(); broadcast('commandsUpdate', bot.commands.getCommands()); }
                    break;
                case 'addCounter': bot.counters.addCounter(data.data.trigger, data.data.response, data.data.oncePerDay); break;
                case 'removeCounter': bot.counters.removeCounter(data.data.trigger); break;
                case 'toggleCounter':
                    const tCnt = bot.counters.getCounters().find(c => c.trigger === data.data.trigger);
                    if (tCnt) { tCnt.enabled = data.data.enabled; bot.saveAll(); broadcast('countersUpdate', bot.counters.getCounters()); }
                    break;
                case 'addMacro': bot.macros.addMacro(data.data.interval, data.data.message, data.data.title); break;
                case 'removeMacro': bot.macros.removeMacro(data.data.id); break;
                case 'updateMacro': bot.macros.updateMacro(data.data.id, data.data.interval, data.data.message, data.data.title); break;
                case 'toggleMacro':
                    const tMac = bot.macros.getMacros().find(m => m.id === data.data.id);
                    if (tMac) { tMac.enabled = data.data.enabled; bot.saveAll(); broadcast('macrosUpdate', bot.macros.getMacros()); }
                    break;
                case 'toggleParticipation': bot.participation.getState().isParticipationActive ? bot.participation.stopParticipation() : bot.participation.startParticipation(); break;
                case 'moveToParticipants': bot.participation.moveToParticipants(data.data.userIdHash); break;
                case 'removeParticipant': bot.participation.removeUser(data.data.userIdHash); break;
                case 'clearParticipants': bot.participation.clearAllData(); break;
                case 'updateMaxParticipants': bot.participation.updateMax(data.payload.count); break;
                case 'updateGreetSettings': bot.greet.updateSettings(data.data); break;
                case 'resetGreetHistory': bot.greet.clearHistory(); break;
                case 'controlMusic':
                    if (data.action === 'skip') bot.songs.skipSong();
                    if (data.action === 'togglePlayPause') bot.songs.togglePlayPause();
                    if (data.action === 'playNext') bot.songs.playNext();
                    if (data.action === 'remove') bot.songs.removeSong(data.index);
                    break;
                
                // [New Feature Handlers]
                case 'createVote': await bot.vote.createVote(data.title, data.options, data.mode); break;
                case 'startVote': await bot.vote.startVote(); break;
                case 'endVote': await bot.vote.endVote(); break;
                case 'deleteVote': await bot.vote.deleteVote(data.voteId); break;
                case 'pickVoteWinner': 
                    const winners = await bot.vote.pickWinner(data.voteId, data.optionId, data.count);
                    ws.send(JSON.stringify({ type: 'voteWinnerResult', payload: winners }));
                    break;
                case 'getBallots':
                    const ballots = await bot.vote.getBallots(data.voteId);
                    ws.send(JSON.stringify({ type: 'voteBallotsResponse', payload: ballots }));
                    break;
                case 'getVoteHistory':
                    const history = await bot.vote.getVoteHistory();
                    ws.send(JSON.stringify({ type: 'voteHistoryResponse', payload: history }));
                    break;
                
                case 'startDraw': bot.draw.startDraw(data.settings); break;
                case 'pickWinners': await bot.draw.pickWinners(); break;
                
                case 'updateRoulette': bot.roulette.updateItems(data.items); break;
                case 'spinRoulette': bot.roulette.spin(); break;
                
                case 'toggleOverlay': bot.overlayManager.setVisible(data.visible); break;
                case 'setOverlayView': bot.overlayManager.setView(data.view); break;
            }
        } catch (err) { console.error('[WS] System Error:', err); }
    });

    ws.on('close', () => { clients.delete(ws); });
});

server.listen(port, '0.0.0.0', () => console.log(`✅ gummybot Server Online: Port ${port}`));