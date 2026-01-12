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
        await supabase
            .from('channels')
            .upsert({
                channel_id: session.user.channelId,
                session_id: session.sessionId,
                session_data: session,
                updated_at: new Date().toISOString()
            });
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
        const session = await this.getSessionFromDB(sessionId);
        if (!session) return null;

        if (session.tokens.expiresAt < Date.now()) {
            // 토큰 갱신 로직 (생략 가능하나 구현 권장)
            return session; // 일단 그대로 반환
        }
        return session;
    }

    public isConfigured(): boolean { return !!(this.clientId && this.clientSecret); }
}
