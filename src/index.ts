import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocket, WebSocketServer } from 'ws';
import { BotManager } from './BotManager';
import { supabase } from './supabase';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const port = process.env.PORT || 8080;

// CORS 설정
const allowedOrigins: string[] = [
  'http://localhost:3000',
  'https://mugumchzzkbot.vercel.app',
  process.env.DASHBOARD_URL,
].filter((x): x is string => typeof x === 'string');

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());

// 봇 매니저 초기화
const botManager = BotManager.getInstance();

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeBots: botManager.getActiveBotsCount(),
    uptime: process.uptime(),
  });
});

// API: 봇 상태 확인
app.get('/api/bot/:userId/status', async (req, res) => {
  const { userId } = req.params;
  const bot = botManager.getBot(userId);

  if (bot) {
    res.json({
      connected: bot.isConnected(),
      channelId: bot.getChannelId(),
    });
  } else {
    res.json({ connected: false });
  }
});

// API: 봇 시작
app.post('/api/bot/:userId/start', async (req, res) => {
  const { userId } = req.params;

  try {
    // bot_sessions에서 is_active를 true로 설정
    await supabase
      .from('bot_sessions')
      .update({ is_active: true, error_message: null })
      .eq('user_id', userId);

    // 봇 매니저가 다음 폴링에서 자동으로 봇을 시작함
    res.json({ success: true, message: '봇 시작 요청됨' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API: 봇 중지
app.post('/api/bot/:userId/stop', async (req, res) => {
  const { userId } = req.params;

  try {
    await supabase
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('user_id', userId);

    // 봇 매니저가 다음 폴링에서 자동으로 봇을 중지함
    res.json({ success: true, message: '봇 중지 요청됨' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// WebSocket 연결 관리
const userConnections: Map<string, Set<WebSocket>> = new Map();

wss.on('connection', (ws, req) => {
  console.log('[WS] New connection');

  let userId: string | null = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      // 인증 메시지
      if (data.type === 'auth') {
        userId = data.userId;

        if (!userId) {
          ws.send(JSON.stringify({ type: 'error', message: 'userId가 필요합니다.' }));
          return;
        }

        // 사용자 연결 등록
        if (!userConnections.has(userId)) {
          userConnections.set(userId, new Set());
        }
        userConnections.get(userId)!.add(ws);

        console.log(`[WS] User ${userId} authenticated`);

        // 봇 상태 전송
        const bot = botManager.getBot(userId);
        ws.send(JSON.stringify({
          type: 'authResult',
          success: true,
          botConnected: bot?.isConnected() ?? false,
        }));

        // 현재 상태 전송
        if (bot) {
          ws.send(JSON.stringify({ type: 'voteUpdate', payload: bot.getVoteState() }));
          ws.send(JSON.stringify({ type: 'drawUpdate', payload: bot.getDrawState() }));
          ws.send(JSON.stringify({ type: 'rouletteUpdate', payload: bot.getRouletteState() }));
        }

        return;
      }

      // userId 없으면 무시
      if (!userId) {
        ws.send(JSON.stringify({ type: 'error', message: '먼저 인증이 필요합니다.' }));
        return;
      }

      const bot = botManager.getBot(userId);

      // 봇이 없으면 에러
      if (!bot && data.type !== 'startBot') {
        ws.send(JSON.stringify({ type: 'error', message: '봇이 연결되어 있지 않습니다.' }));
        return;
      }

      // 메시지 처리
      switch (data.type) {
        // ========== 봇 제어 ==========
        case 'startBot':
          await supabase
            .from('bot_sessions')
            .update({ is_active: true, error_message: null })
            .eq('user_id', userId);
          ws.send(JSON.stringify({ type: 'botStarting' }));
          break;

        case 'stopBot':
          await supabase
            .from('bot_sessions')
            .update({ is_active: false })
            .eq('user_id', userId);
          ws.send(JSON.stringify({ type: 'botStopping' }));
          break;

        case 'sendChat':
          if (bot && data.message) {
            bot.sendChat(data.message);
          }
          break;

        // ========== 투표 ==========
        case 'startVote':
          if (bot) bot.vote.startVote(data.title, data.mode, data.items, data.duration, data.allowMulti, data.unit);
          break;
        case 'endVote':
          if (bot) bot.vote.endVote();
          break;
        case 'stopVote':
          if (bot) bot.vote.stopVote();
          break;
        case 'toggleVoteOverlay':
          if (bot) bot.vote.toggleVoteOverlay(data.show);
          break;

        // ========== 시청자 추첨 ==========
        case 'startDrawRecruit':
          if (bot) bot.vote.startDrawRecruit(data.keyword, data.subsOnly, data.duration);
          break;
        case 'pickDrawWinner':
          if (bot) bot.vote.pickDrawWinner(data.count);
          break;
        case 'stopDraw':
          if (bot) bot.vote.stopDraw();
          break;
        case 'toggleDrawOverlay':
          if (bot) bot.vote.toggleDrawOverlay(data.show);
          break;

        // ========== 룰렛 ==========
        case 'updateRoulette':
          if (bot) bot.vote.updateRouletteItems(data.items);
          break;
        case 'spinRoulette':
          if (bot) bot.vote.spinRoulette();
          break;
        case 'resetRoulette':
          if (bot) bot.vote.resetRoulette();
          break;
        case 'toggleRouletteOverlay':
          if (bot) bot.vote.toggleRouletteOverlay(data.show);
          break;

        default:
          console.log(`[WS] Unknown message type: ${data.type}`);
      }
    } catch (err: any) {
      console.error('[WS] Error processing message:', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Connection closed for user ${userId}`);
    if (userId) {
      const connections = userConnections.get(userId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          userConnections.delete(userId);
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] WebSocket error:', err);
  });
});

// 특정 사용자에게 브로드캐스트
function broadcastToUser(userId: string, data: any) {
  const connections = userConnections.get(userId);
  if (connections) {
    const message = JSON.stringify(data);
    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
}

// 봇 매니저에 브로드캐스트 함수 등록
botManager.setBroadcastFunction(broadcastToUser);

// 시작
console.log('=================================');
console.log('  Chzzk Bot Server Starting...  ');
console.log('=================================');

botManager.start();

server.listen(port, () => {
  console.log(`✅ HTTP/WS Server running on port ${port}`);
});

// 종료 처리
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  await botManager.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] Shutting down...');
  await botManager.stop();
  process.exit(0);
});

export { broadcastToUser };
