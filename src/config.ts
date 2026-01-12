// src/config.ts

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const config = {
  // 네이버 쿠키 (봇 계정용 - 채팅 전송에 필요)
  nidAuth: process.env.NID_AUT || "",
  nidSes: process.env.NID_SES || "",
  
  // YouTube API
  youtubeApiKey: process.env.YOUTUBE_API_KEY || "",
  
  // 서버 포트
  port: process.env.PORT || 3000,
  
  // 치지직 OAuth 설정 (대시보드 로그인용)
  chzzk: {
    clientId: process.env.CHZZK_CLIENT_ID || "",
    clientSecret: process.env.CHZZK_CLIENT_SECRET || "",
    // 개발 환경에서는 http://localhost:3000/auth/callback
    redirectUri: process.env.CHZZK_REDIRECT_URI || "http://localhost:3000/auth/callback"
  }
};