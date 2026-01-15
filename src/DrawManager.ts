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
        
        if (settings.target === 'donation') {
            this.loadDonors(settings.minAmount || 0);
        }

        // [New] 채팅 알림
        if (this.bot.chat && this.bot.settings.getSettings().chatEnabled) {
            let msg = `📢 [추첨 시작] ${settings.winnerCount}명을 뽑습니다!`;
            let subMsg = '';

            if (settings.target === 'chat') {
                subMsg = `👉 채팅창에 '${settings.command || '!참여'}'를 입력하세요!`;
            } else if (settings.target === 'all') {
                subMsg = `👉 채팅을 입력하면 자동으로 참여됩니다!`;
            } else if (settings.target === 'subscriber') {
                subMsg = `👉 채팅을 입력하면 참여됩니다! (⭐구독자 전용)`;
            } else if (settings.target === 'donation') {
                subMsg = `👉 ${settings.minAmount}원 이상 후원하신 분들 대상입니다!`;
            }

            this.bot.chat.sendChat(msg);
            if (subMsg) this.bot.chat.sendChat(subMsg);
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

    // [New] 추첨 초기화
    public resetDraw() {
        this.isCollecting = false;
        this.participants.clear();
        this.donationPool = [];
        this.winners = [];
        this.drawStatus = 'idle';
        this.bot.overlayManager?.setView('none');
        this.notify();
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
