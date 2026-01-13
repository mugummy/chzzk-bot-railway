// src/main.ts - Professional Production Server

import { ChatBot } from './Bot';
import express from 'express';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config';
import { AuthManager } from './AuthManager';
import cookieParser from 'cookie-parser';
import cors from 'cors';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = parseInt(process.env.PORT || '8080', 10);
const authManager = new AuthManager(config.chzzk.clientId, config.chzzk.clientSecret, config.chzzk.redirectUri);

const channelBotMap: Map<string, ChatBot> = new Map();
const channelClientsMap: Map<string, Set<WebSocket>> = new Map();

app.use(cors({ origin: ["https://mugumchzzkbot.vercel.app", "http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(cookieParser());

// HTTP Endpoints
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
    if (!result.success || !result.session) return res.redirect("https://mugumchzzkbot.vercel.app/?error=auth");
    res.redirect(`https://mugumchzzkbot.vercel.app/dashboard.html?session=${result.session.sessionId}`);
});

// WebSocket Hub
wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const session = token ? await authManager.validateSession(token) : null;
    if (!session) return ws.close();

    const channelId = session.user.channelId;
    if (!channelClientsMap.has(channelId)) channelClientsMap.set(channelId, new Set());
    const clients = channelClientsMap.get(channelId)!;
    clients.add(ws);

    const broadcast = (msg: any) => {
        const data = JSON.stringify(msg);
        clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(data));
    };

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            let bot = channelBotMap.get(channelId);

            if (data.type === 'connect') {
                if (!bot) {
                    bot = new ChatBot(channelId);
                    await bot.connect();
                    channelBotMap.set(channelId, bot);

                    // Real-time Event Wiring
                    bot.setOnStateChangeListener('vote', () => broadcast({ type: 'voteStateUpdate', payload: bot!.voteManager.getState() }));
                    bot.setOnStateChangeListener('draw', () => broadcast({ type: 'drawStateUpdate', payload: bot!.drawManager.getState() }));
                    bot.setOnStateChangeListener('song', () => broadcast({ type: 'songStateUpdate', payload: bot!.songManager.getState() }));
                    bot.setOnStateChangeListener('settings', () => broadcast({ type: 'settingsUpdate', payload: bot!.settings }));
                    bot.setOnStateChangeListener('overlay', () => broadcast({ type: 'overlaySettingsUpdate', payload: bot!.overlaySettings }));
                                    bot.setOnStateChangeListener('participation', () => broadcast({ type: 'participationStateUpdate', payload: bot!.participationManager.getState() }));
                                    bot.setOnStateChangeListener('points', () => broadcast({ type: 'pointsUpdate', payload: bot!.pointManager.getPointsData() }));
                                    
                                    // 추가된 리스너들
                                    bot.setOnStateChangeListener('commands', () => broadcast({ type: 'commandsUpdate', payload: bot!.commandManager.getCommands() }));
                                    bot.setOnStateChangeListener('macros', () => broadcast({ type: 'macrosUpdate', payload: bot!.macroManager.getMacros() }));
                                    bot.setOnStateChangeListener('counters', () => broadcast({ type: 'countersUpdate', payload: bot!.counterManager.getCounters() }));
                                    
                                    bot.setOnChatListener((chat) => broadcast({ type: 'newChat', payload: chat }));                }
                ws.send(JSON.stringify({ type: 'connectResult', success: true, channelInfo: bot.getChannelInfo() }));
                return;
            }

            if (!bot) return;

            // Atomic Action Handlers
            switch (data.type) {
                case 'requestData':
                    ws.send(JSON.stringify({ type: 'settingsUpdate', payload: bot.settings }));
                    ws.send(JSON.stringify({ type: 'overlaySettingsUpdate', payload: bot.overlaySettings }));
                    ws.send(JSON.stringify({ type: 'commandsUpdate', payload: bot.commandManager.getCommands() }));
                    ws.send(JSON.stringify({ type: 'macrosUpdate', payload: bot.macroManager.getMacros() }));
                    ws.send(JSON.stringify({ type: 'countersUpdate', payload: bot.counterManager.getCounters() }));
                    ws.send(JSON.stringify({ type: 'songStateUpdate', payload: bot.songManager.getState() }));
                    ws.send(JSON.stringify({ type: 'voteStateUpdate', payload: bot.voteManager.getState() }));
                    ws.send(JSON.stringify({ type: 'participationStateUpdate', payload: bot.participationManager.getState() }));
                    ws.send(JSON.stringify({ type: 'greetStateUpdate', payload: bot.greetManager.getState() }));
                    break;
                case 'updateGreetSettings': bot.greetManager.updateSettings(data.data); break;
                case 'resetGreetHistory': bot.greetManager.clearHistory(); break;
                case 'updateSettings': bot.updateSettings(data.data); break;
                case 'updateOverlaySettings': bot.updateOverlaySettings(data.payload); break;
                case 'addCommand': bot.commandManager.addCommand(data.data.trigger, data.data.response); break;
                case 'removeCommand': bot.commandManager.removeCommand(data.data.trigger); break;
                case 'addMacro': bot.macroManager.addMacro(data.data.interval, data.data.message); break;
                case 'removeMacro': bot.macroManager.removeMacro(data.data.id); break;
                case 'addCounter': bot.counterManager.addCounter(data.data.trigger, data.data.response); break;
                case 'removeCounter': bot.counterManager.removeCounter(data.data.trigger); break;
                case 'startDraw': bot.drawManager.startSession(data.payload.keyword, data.payload.settings); break;
                case 'executeDraw': 
                    const drawWin = bot.drawManager.draw(data.payload.count);
                    if (drawWin.success) broadcast({ type: 'drawWinnerResult', payload: { winners: drawWin.winners } });
                    break;
                case 'resetDraw': bot.drawManager.reset(); break;
                case 'createVote': bot.voteManager.createVote(data.data.question, data.data.options, data.data.durationSeconds); break;
                case 'startVote': bot.voteManager.startVote(); break;
                case 'endVote': bot.voteManager.endVote(); break;
                case 'resetVote': bot.voteManager.resetVote(); break;
                case 'createRoulette': bot.rouletteManager.createRoulette(data.payload.items); break;
                case 'spinRoulette':
                    const spin = bot.rouletteManager.spin();
                    if (spin.success) broadcast({ type: 'rouletteSpinResult', payload: spin });
                    break;
                case 'toggleParticipation': bot.participationManager.isActive() ? bot.participationManager.stopParticipation() : bot.participationManager.startParticipation(); break;
                case 'moveToParticipants': bot.participationManager.moveToParticipants(data.data.userIdHash); break;
                case 'clearParticipants': bot.participationManager.clearAllData(); break;
                case 'controlMusic':
                    if (data.action === 'skip') bot.songManager.skipSong();
                    if (data.action === 'togglePlayPause') bot.songManager.togglePlayPause();
                    if (data.action === 'deleteCurrent') bot.songManager.removeCurrentSong();
                    break;
            }
        } catch (err) { console.error('[WS] Critical Error:', err); }
    });

    ws.on('close', () => clients.delete(ws));
});

server.listen(port, '0.0.0.0', () => console.log(`🚀 System Online: Port ${port}`));