// src/AuthManager.ts
// 치지직 OAuth 2.0 인증 관리

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '..', 'auth_data.json');

export interface ChzzkTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;  // timestamp
    refreshExpiresAt: number;  // timestamp (0 = 영구)
}

export interface ChzzkUser {
    channelId: string;
    channelName: string;
    channelImageUrl?: string;
    verifiedMark?: boolean;
}

export interface AuthSession {
    sessionId: string;
    user: ChzzkUser;
    tokens: ChzzkTokens;
    createdAt: number;
}

interface AuthData {
    sessions: { [sessionId: string]: AuthSession };
    pendingStates: { [state: string]: { createdAt: number; redirectPath?: string } };
}

export class AuthManager {
    private clientId: string;
    private clientSecret: string;
    private redirectUri: string;
    private data: AuthData;

    // 치지직 API 엔드포인트
    private readonly AUTH_URL = 'https://chzzk.naver.com/account-interlock';
    private readonly TOKEN_URL = 'https://openapi.chzzk.naver.com/auth/v1/token';
    private readonly USER_URL = 'https://openapi.chzzk.naver.com/open/v1/users/me';
    private readonly REVOKE_URL = 'https://openapi.chzzk.naver.com/auth/v1/token/revoke';

    constructor(clientId: string, clientSecret: string, redirectUri: string) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.redirectUri = redirectUri;
        this.data = this.loadData();
        
        // 만료된 세션 정리
        this.cleanupExpiredSessions();
    }

    private loadData(): AuthData {
        try {
            if (fs.existsSync(AUTH_FILE)) {
                const content = fs.readFileSync(AUTH_FILE, 'utf-8');
                return JSON.parse(content);
            }
        } catch (e) {
            console.log('[AuthManager] Failed to load auth data, creating new');
        }
        return { sessions: {}, pendingStates: {} };
    }

    private saveData(): void {
        try {
            fs.writeFileSync(AUTH_FILE, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error('[AuthManager] Failed to save auth data:', e);
        }
    }

    private cleanupExpiredSessions(): void {
        const now = Date.now();
        let changed = false;

        // 만료된 세션 제거 (refreshExpiresAt이 0이면 영구 세션)
        for (const sessionId in this.data.sessions) {
            const session = this.data.sessions[sessionId];
            if (session.tokens.refreshExpiresAt > 0 && session.tokens.refreshExpiresAt < now) {
                delete this.data.sessions[sessionId];
                changed = true;
                console.log(`[AuthManager] Removed expired session: ${sessionId}`);
            }
        }

        // 오래된 pending states 제거 (10분 이상)
        for (const state in this.data.pendingStates) {
            if (now - this.data.pendingStates[state].createdAt > 10 * 60 * 1000) {
                delete this.data.pendingStates[state];
                changed = true;
            }
        }

        if (changed) {
            this.saveData();
        }
    }

    /**
     * OAuth 인증 URL 생성
     */
    public generateAuthUrl(redirectPath?: string): { url: string; state: string } {
        const state = uuidv4().replace(/-/g, '').substring(0, 16);
        
        // state 저장
        this.data.pendingStates[state] = { 
            createdAt: Date.now(),
            redirectPath 
        };
        this.saveData();

        const params = new URLSearchParams({
            clientId: this.clientId,
            redirectUri: this.redirectUri,
            state: state
        });

        return {
            url: `${this.AUTH_URL}?${params.toString()}`,
            state
        };
    }

    /**
     * 인증 코드로 토큰 발급
     */
    public async exchangeCodeForTokens(code: string, state: string): Promise<{ success: boolean; session?: AuthSession; error?: string }> {
        // state 검증
        if (!this.data.pendingStates[state]) {
            return { success: false, error: 'Invalid or expired state' };
        }

        const pendingState = this.data.pendingStates[state];
        delete this.data.pendingStates[state];
        this.saveData();

        try {
            // 토큰 요청
            const tokenResponse = await axios.post(this.TOKEN_URL, {
                grantType: 'authorization_code',
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                code: code,
                state: state
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (tokenResponse.data.code !== 200) {
                console.error('[AuthManager] Token exchange failed:', tokenResponse.data);
                return { success: false, error: tokenResponse.data.message || 'Token exchange failed' };
            }

            const tokenData = tokenResponse.data.content;
            const now = Date.now();
            
            const tokens: ChzzkTokens = {
                accessToken: tokenData.accessToken,
                refreshToken: tokenData.refreshToken,
                expiresAt: now + (tokenData.expiresIn * 1000),  // expiresIn은 초 단위
                refreshExpiresAt: 0  // 0 = 영구 세션 (만료 없음)
            };

            // 사용자 정보 조회
            const user = await this.getUserInfo(tokens.accessToken);
            if (!user) {
                return { success: false, error: 'Failed to get user info' };
            }

            // 세션 생성
            const sessionId = uuidv4();
            const session: AuthSession = {
                sessionId,
                user,
                tokens,
                createdAt: now
            };

            this.data.sessions[sessionId] = session;
            this.saveData();

            console.log(`[AuthManager] New session created for channel: ${user.channelName} (${user.channelId})`);

            return { success: true, session };

        } catch (e: any) {
            console.error('[AuthManager] Token exchange error:', e.response?.data || e.message);
            return { success: false, error: e.response?.data?.message || e.message };
        }
    }

    /**
     * Access Token으로 사용자 정보 조회
     */
    private async getUserInfo(accessToken: string): Promise<ChzzkUser | null> {
        try {
            const response = await axios.get(this.USER_URL, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (response.data.code !== 200) {
                console.error('[AuthManager] Get user info failed:', response.data);
                return null;
            }

            const content = response.data.content;
            return {
                channelId: content.channelId,
                channelName: content.channelName,
                channelImageUrl: content.channelImageUrl,
                verifiedMark: content.verifiedMark
            };

        } catch (e: any) {
            console.error('[AuthManager] Get user info error:', e.response?.data || e.message);
            return null;
        }
    }

    /**
     * 세션 검증 및 토큰 갱신
     */
    public async validateSession(sessionId: string): Promise<AuthSession | null> {
        const session = this.data.sessions[sessionId];
        if (!session) {
            return null;
        }

        const now = Date.now();

        // refresh token 만료 확인 (0이면 영구 세션이므로 스킵)
        if (session.tokens.refreshExpiresAt > 0 && session.tokens.refreshExpiresAt < now) {
            delete this.data.sessions[sessionId];
            this.saveData();
            return null;
        }

        // access token 만료 시 갱신
        if (session.tokens.expiresAt < now) {
            const refreshed = await this.refreshTokens(sessionId);
            if (!refreshed) {
                return null;
            }
        }

        return this.data.sessions[sessionId];
    }

    /**
     * 토큰 갱신
     */
    private async refreshTokens(sessionId: string): Promise<boolean> {
        const session = this.data.sessions[sessionId];
        if (!session) return false;

        try {
            const response = await axios.post(this.TOKEN_URL, {
                grantType: 'refresh_token',
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                refreshToken: session.tokens.refreshToken
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.data.code !== 200) {
                console.error('[AuthManager] Token refresh failed:', response.data);
                delete this.data.sessions[sessionId];
                this.saveData();
                return false;
            }

            const tokenData = response.data.content;
            const now = Date.now();

            session.tokens.accessToken = tokenData.accessToken;
            session.tokens.refreshToken = tokenData.refreshToken;
            session.tokens.expiresAt = now + (tokenData.expiresIn * 1000);
            
            this.saveData();
            console.log(`[AuthManager] Tokens refreshed for session: ${sessionId}`);
            return true;

        } catch (e: any) {
            console.error('[AuthManager] Token refresh error:', e.response?.data || e.message);
            delete this.data.sessions[sessionId];
            this.saveData();
            return false;
        }
    }

    /**
     * 로그아웃 (토큰 삭제)
     */
    public async logout(sessionId: string): Promise<boolean> {
        const session = this.data.sessions[sessionId];
        if (!session) return false;

        try {
            // 토큰 revoke 요청
            await axios.post(this.REVOKE_URL, {
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                token: session.tokens.accessToken,
                tokenTypeHint: 'access_token'
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });
        } catch (e) {
            // revoke 실패해도 세션은 삭제
            console.log('[AuthManager] Token revoke failed, but continuing logout');
        }

        delete this.data.sessions[sessionId];
        this.saveData();
        console.log(`[AuthManager] Session logged out: ${sessionId}`);
        return true;
    }

    /**
     * 세션으로 채널 ID 가져오기
     */
    public getChannelIdFromSession(sessionId: string): string | null {
        const session = this.data.sessions[sessionId];
        return session?.user.channelId || null;
    }

    /**
     * 세션 정보 가져오기
     */
    public getSession(sessionId: string): AuthSession | null {
        return this.data.sessions[sessionId] || null;
    }

    /**
     * 클라이언트 설정 여부 확인
     */
    public isConfigured(): boolean {
        return !!(this.clientId && this.clientSecret && this.redirectUri);
    }
}
