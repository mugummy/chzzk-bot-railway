// src/main.ts - Expert Broadcast Hub

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

                    bot.setOnStateChangeListener('vote', () => broadcast({ type: 'voteStateUpdate', payload: bot!.voteManager.getState() }));
                    bot.setOnStateChangeListener('draw', () => broadcast({ type: 'drawStateUpdate', payload: bot!.drawManager.getState() }));
                    bot.setOnStateChangeListener('song', () => broadcast({ type: 'songStateUpdate', payload: bot!.songManager.getState() }));
                    bot.setOnStateChangeListener('settings', () => broadcast({ type: 'settingsUpdate', payload: bot!.settings }));
                    bot.setOnStateChangeListener('overlay', () => broadcast({ type: 'overlaySettingsUpdate', payload: bot!.overlaySettings }));
                    bot.setOnStateChangeListener('participation', () => broadcast({ type: 'participationStateUpdate', payload: bot!.participationManager.getState() }));
                    bot.setOnChatListener((chat) => broadcast({ type: 'newChat', payload: chat }));
                }
                ws.send(JSON.stringify({ type: 'connectResult', success: true, channelInfo: bot.getChannelInfo(), liveStatus: bot.getLiveStatus() }));
                return;
            }

            if (!bot) return;

            switch (data.type) {
                case 'requestData':
                    ws.send(JSON.stringify({ type: 'settingsUpdate', payload: bot.settings }));
                    ws.send(JSON.stringify({ type: 'commandsUpdate', payload: bot.commandManager.getCommands() }));
                    ws.send(JSON.stringify({ type: 'songStateUpdate', payload: bot.songManager.getState() }));
                    ws.send(JSON.stringify({ type: 'voteStateUpdate', payload: bot.voteManager.getState() }));
                    break;
                case 'createVote': bot.voteManager.createVote(data.data.question, data.data.options, data.data.settings); break;
                case 'startVote': bot.voteManager.startVote(); break;
                case 'endVote': bot.voteManager.endVote(); break;
                case 'resetVote': bot.voteManager.resetVote(); break;
                case 'updateSettings': bot.updateSettings(data.data); break;
                case 'updateOverlaySettings': bot.updateOverlaySettings(data.payload); break;
                case 'addCommand': bot.commandManager.addCommand(data.data.trigger, data.data.response); break;
                case 'removeCommand': bot.commandManager.removeCommand(data.data.trigger); break;
                case 'controlMusic':
                    if (data.action === 'skip') bot.songManager.skipSong();
                    if (data.action === 'togglePlayPause') bot.songManager.togglePlayPause();
                    break;
            }
        } catch (err) {}
    });

    ws.on('close', () => clients.delete(ws));
});

server.listen(port, '0.0.0.0', () => console.log(`✅ Running on ${port}`));
