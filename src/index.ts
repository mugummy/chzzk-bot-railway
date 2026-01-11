import 'dotenv/config';
import { BotManager } from './BotManager';

console.log('=================================');
console.log('  Chzzk Bot Server Starting...  ');
console.log('=================================');

const botManager = new BotManager();

// 시작
botManager.start();

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
