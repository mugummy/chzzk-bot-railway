import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { DataManager } from './DataManager';
import { supabase } from './supabase';

export interface ChzzkTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    refreshExpiresAt: number;
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

export class AuthManager {
    private clientId: string;
    private clientSecret: string;
    private redirectUri: string;

    // 임시 메모리 저장 (성능용 + Pending State용)
    private pendingStates: { [state: string]: { createdAt: number; redirectPath?: string } } = {};

    private readonly AUTH_URL = 'https://chzzk.naver.com/account-interlock';
    private readonly TOKEN_URL = 'https://openapi.chzzk.naver.com/auth/v1/token';
    private readonly USER_URL = 'https://openapi.chzzk.naver.com/open/v1/users/me';

    constructor(clientId: string, clientSecret: string, redirectUri: string) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.redirectUri = redirectUri;
    }

    /**
     * DB에서 세션 조회
     */
    public async getSessionFromDB(sessionId: string): Promise<AuthSession | null> {
        // channels 테이블의 session_data 컬럼이나 별도 세션 테이블에서 조회 (여기선 channels 테이블 활용 권장)
        const { data, error } = await supabase
            .from('channels')
            .select('session_data')
            .eq('session_id', sessionId)
            .single();

        if (error || !data || !data.session_data) return null;
        return data.session_data as AuthSession;
    }

    /**
     * DB에 세션 저장
     */
    private async saveSessionToDB(session: AuthSession): Promise<void> {
        console.log(`[AuthManager] Saving session to DB for channel: ${session.user.channelId}`);
        const { error } = await supabase
            .from('channels')
            .upsert({
                channel_id: session.user.channelId,
                session_id: session.sessionId,
                session_data: session,
                updated_at: new Date().toISOString()
            });
        
        if (error) {
            console.error('[AuthManager] DB Upsert Error:', error);
        } else {
            console.log('[AuthManager] DB Upsert Success');
        }
    }

    public generateAuthUrl(redirectPath?: string): { url: string; state: string } {
        const state = uuidv4().replace(/-/g, '').substring(0, 16);
        this.pendingStates[state] = { createdAt: Date.now(), redirectPath };

        const params = new URLSearchParams({
            clientId: this.clientId,
            redirectUri: this.redirectUri,
            state: state
        });

        return { url: `${this.AUTH_URL}?${params.toString()}`, state };
    }

    public async exchangeCodeForTokens(code: string, state: string): Promise<{ success: boolean; session?: AuthSession; error?: string }> {
        if (!this.pendingStates[state]) return { success: false, error: 'Invalid state' };
        delete this.pendingStates[state];

        try {
            const tokenResponse = await axios.post(this.TOKEN_URL, {
                grantType: 'authorization_code',
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                code: code,
                state: state
            });

            const tokenData = tokenResponse.data.content;
            const user = await this.getUserInfo(tokenData.accessToken);
            if (!user) return { success: false, error: 'Failed to get user info' };

            const session: AuthSession = {
                sessionId: uuidv4(),
                user,
                tokens: {
                    accessToken: tokenData.accessToken,
                    refreshToken: tokenData.refreshToken,
                    expiresAt: Date.now() + (tokenData.expiresIn * 1000),
                    refreshExpiresAt: 0
                },
                createdAt: Date.now()
            };

            // DB 저장
            await this.saveSessionToDB(session);
            await DataManager.loadData(user.channelId); // 초기 데이터 생성

            return { success: true, session };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    private async getUserInfo(accessToken: string): Promise<ChzzkUser | null> {
        try {
            const res = await axios.get(this.USER_URL, { headers: { 'Authorization': `Bearer ${accessToken}` } });
            const c = res.data.content;
            return { channelId: c.channelId, channelName: c.channelName, channelImageUrl: c.channelImageUrl };
        } catch { return null; }
    }

    public async validateSession(sessionId: string): Promise<AuthSession | null> {
        let session = await this.getSessionFromDB(sessionId);
        
        if (!session) {
            console.log(`[AuthManager] Session not found initially: ${sessionId}. Retrying in 1s...`);
            await new Promise(r => setTimeout(r, 1000));
            session = await this.getSessionFromDB(sessionId);
        }

        if (!session) {
            console.log(`[AuthManager] Session still not found in DB after retry: ${sessionId}`);
            return null;
        }

        console.log(`[AuthManager] Session validated: ${session.user.channelName} (${sessionId})`);
        return session;
    }

    /**
     * 토큰 갱신 (DB 기반)
     */
    private async refreshTokens(sessionId: string): Promise<boolean> {
        const session = await this.getSessionFromDB(sessionId);
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
                return false;
            }

            const tokenData = response.data.content;
            const now = Date.now();

            session.tokens.accessToken = tokenData.accessToken;
            session.tokens.refreshToken = tokenData.refreshToken;
            session.tokens.expiresAt = now + (tokenData.expiresIn * 1000);
            
            // DB 업데이트
            await this.saveSessionToDB(session);
            console.log(`[AuthManager] Tokens refreshed and saved to DB for session: ${sessionId}`);
            return true;

        } catch (e: any) {
            console.error('[AuthManager] Token refresh error:', e.response?.data || e.message);
            return false;
        }
    }

    /**
     * 로그아웃 (토큰 삭제)
     */
    public async logout(sessionId: string): Promise<boolean> {
        const session = await this.getSessionFromDB(sessionId);
        if (!session) return false;

        try {
            // 토큰 revoke 요청
            await axios.post('https://openapi.chzzk.naver.com/auth/v1/token/revoke', {
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
            console.log('[AuthManager] Token revoke failed, but continuing logout');
        }

        // DB에서 세션 삭제 (session_id를 null로 업데이트하거나 row 삭제)
        // 여기선 간단하게 session_data를 null로 만듦
        await supabase
            .from('channels')
            .update({ session_id: null, session_data: null })
            .eq('session_id', sessionId);
            
        console.log(`[AuthManager] Session logged out: ${sessionId}`);
        return true;
    }

    public getChannelIdFromSession(sessionId: string): string | null {
        // 비동기라 직접 호출 불가, validateSession 사용 권장
        return null; 
    }

    public isConfigured(): boolean { return !!(this.clientId && this.clientSecret); }
}
