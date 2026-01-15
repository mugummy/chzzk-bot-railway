import { ChatEvent } from 'chzzk';
import { BotInstance } from './BotInstance';
import { supabase } from './supabase';

export interface DrawSettings {
    target: 'all' | 'chat' | 'subscriber' | 'donation';
    winnerCount: number;
    command?: string; // 채팅 참여일 경우
    minAmount?: number; // 후원 참여일 경우
    allowDuplicate: boolean;
}

export class DrawManager {
    private participants: Set<string> = new Set(); // 채팅 참여자 (userIdHash)
    private donationPool: { userIdHash: string, nickname: string, amount: number }[] = []; 
    private isCollecting: boolean = false;
    private currentSettings: DrawSettings | null = null;
    
    // 오버레이 연출용 상태
    private drawStatus: 'idle' | 'rolling' | 'completed' = 'idle';
    private winners: any[] = [];

    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('drawStateUpdate', this.getState());
    }

    public getState() {
        return {
            isCollecting: this.isCollecting,
            participantCount: this.currentSettings?.target === 'donation' ? this.donationPool.length : this.participants.size,
            settings: this.currentSettings,
            status: this.drawStatus,
            winners: this.winners
        };
    }

    // 추첨 시작 (참여자 모집 시작)
    public startDraw(settings: DrawSettings) {
        this.currentSettings = settings;
        this.isCollecting = true;
        this.participants.clear();
        this.donationPool = [];
        this.winners = [];
        this.drawStatus = 'idle';
        
        // 후원자 추첨인 경우 DB에서 최근 후원 내역 로드 (예: 최근 1시간?) -> 여기서는 단순화를 위해 실시간 모집 or 전체 로드
        // 기획상 "후원자 자동 수집"이므로, 별도 함수로 DB에서 긁어오는게 좋음.
        if (settings.target === 'donation') {
            this.loadDonors(settings.minAmount || 0);
        }

        this.notify();
    }

    private async loadDonors(minAmount: number) {
        // 오늘 날짜 기준 혹은 특정 시점 이후 후원자 로드
        const { data } = await supabase
            .from('donation_logs')
            .select('*')
            .eq('channel_id', this.bot.getChannelId())
            .gte('amount', minAmount)
            .order('created_at', { ascending: false })
            .limit(500); // 최대 500명 제한

        if (data) {
            this.donationPool = data.map(d => ({ userIdHash: d.user_id_hash, nickname: d.nickname, amount: d.amount }));
            this.notify();
        }
    }

    // 채팅 이벤트 핸들링 (참여 명령어)
    public handleChat(chat: ChatEvent) {
        if (!this.isCollecting || !this.currentSettings) return;
        if (this.currentSettings.target !== 'chat') return;

        const cmd = this.currentSettings.command || '!참여';
        if (chat.message.trim() === cmd) {
            this.participants.add(JSON.stringify({ id: chat.profile.userIdHash, nick: chat.profile.nickname }));
            this.notify(); // 실시간 인원 수 업데이트
        }
    }

    // 추첨 실행 (결과 산출)
    public async pickWinners() {
        if (!this.currentSettings) return;
        this.isCollecting = false;
        this.drawStatus = 'rolling';
        
        let pool: any[] = [];

        if (this.currentSettings.target === 'donation') {
            // 후원자 풀 (가중치 적용 가능)
            pool = this.donationPool;
        } else {
            // 시청자 풀
            pool = Array.from(this.participants).map(p => JSON.parse(p));
        }

        if (pool.length === 0) {
            this.drawStatus = 'completed';
            this.notify();
            return;
        }

        // 추첨 로직
        const count = Math.min(this.currentSettings.winnerCount, pool.length);
        const winners = [];
        const tempPool = [...pool];

        for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * tempPool.length);
            winners.push(tempPool[idx]);
            if (!this.currentSettings.allowDuplicate) {
                tempPool.splice(idx, 1);
            }
        }

        this.winners = winners;
        
        // 오버레이에 애니메이션 시작 신호 전송
        this.bot.overlayManager?.startDrawAnimation(winners);

        // DB 저장
        await supabase.from('draw_history').insert({
            channel_id: this.bot.getChannelId(),
            type: this.currentSettings.target,
            winners: winners,
            settings: this.currentSettings
        });

        // 3초 후 상태 완료로 변경 (애니메이션 시간 고려)
        setTimeout(() => {
            this.drawStatus = 'completed';
            this.notify();
            // 웹소켓으로 대시보드에 결과 알림 (TTS용)
            this.onStateChangeCallback('drawWinnerResult', { winners });
        }, 3000);
    }
}
