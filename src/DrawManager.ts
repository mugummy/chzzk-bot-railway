import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface DrawCandidate {
    userIdHash: string;
    nickname: string;
    source: 'chat' | 'donation' | 'vote';
}

/**
 * DrawManager: 시청자 및 후원자 추첨을 관리합니다.
 */
export class DrawManager {
    private candidates: Map<string, DrawCandidate> = new Map();
    private settings: any = { mode: 'chat', chatType: 'command', chatCommand: '!참가', donationType: 'all', donationAmount: 1000 };
    private isRolling: boolean = false;
    private isActive: boolean = false;
    private winners: DrawCandidate[] = [];
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialData?: any) {
        if (initialData) {
            this.isActive = initialData.isActive || false;
            this.settings = initialData.settings || this.settings;
            if (Array.isArray(initialData.candidates)) {
                initialData.candidates.forEach((c: any) => this.candidates.set(c.userIdHash, c));
            }
        }
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
        this.bot.saveAll(); // 상태 변경 시 즉시 DB 저장
    }

    public startSession(settings: any) {
        this.candidates.clear();
        this.winners = [];
        this.isActive = true;
        this.isRolling = false;
        // 클라이언트 설정을 서버에 동기화
        this.settings = { ...this.settings, ...settings };
        this.notify();
        
        if (this.bot.chat && this.bot.chat.connected) {
            let msg = `🎰 [추첨 모집 시작] `;
            if (this.settings.mode === 'chat') {
                if (this.settings.chatType === 'any') msg += "아무 채팅이나 입력하면 참가됩니다!";
                else msg += `'${this.settings.chatCommand}' 명령어를 입력하면 참가됩니다!`;
            } else {
                if (this.settings.donationType === 'all') msg += "후원 시 자동으로 참가됩니다!";
                else msg += `${this.settings.donationAmount}치즈 후원 시 자동으로 참가됩니다!`;
            }
            this.bot.chat.sendChat(msg);
        }
    }

    public endSession() {
        this.isActive = false;
        this.notify();
        if (this.bot.chat && this.bot.chat.connected) {
            this.bot.chat.sendChat(`⛔ [추첨 모집 마감] 현재 총 ${this.candidates.size}명이 응모했습니다.`);
        }
    }

    public injectCandidatesFromVote(voters: any[]) {
        this.candidates.clear();
        voters.forEach(v => this.candidates.set(v.userIdHash, { userIdHash: v.userIdHash, nickname: v.nickname, source: 'vote' }));
        this.isActive = false;
        this.notify();
    }

    public handleChat(chat: ChatEvent) {
        if (!this.isActive || this.settings.mode !== 'chat' || this.isRolling) return;
        if (chat.profile.userIdHash === this.bot.getChannelId()) return;

        let isValid = false;
        const msg = chat.message.trim();
        
        if (this.settings.chatType === 'any') isValid = true;
        else if (this.settings.chatType === 'command' && msg === this.settings.chatCommand.trim()) isValid = true;

        if (isValid && !this.candidates.has(chat.profile.userIdHash)) {
            this.candidates.set(chat.profile.userIdHash, { 
                userIdHash: chat.profile.userIdHash, 
                nickname: chat.profile.nickname, 
                source: 'chat' 
            });
            this.notify(); // 명단 추가 시 즉시 알림
        }
    }

    public handleDonation(donation: DonationEvent) {
        if (!this.isActive || this.settings.mode !== 'donation' || this.isRolling) return;
        
        let isValid = false;
        if (this.settings.donationType === 'all') isValid = true;
        else if (this.settings.donationType === 'specific' && donation.payAmount === this.settings.donationAmount) isValid = true;

        if (isValid && !this.candidates.has(donation.profile.userIdHash)) {
            this.candidates.set(donation.profile.userIdHash, { 
                userIdHash: donation.profile.userIdHash, 
                nickname: donation.profile.nickname, 
                source: 'donation' 
            });
            this.notify();
        }
    }

    public draw(count: number = 1) {
        const pool = Array.from(this.candidates.values());
        if (pool.length === 0) return;

        this.isActive = false;
        this.isRolling = true;
        this.winners = [];
        this.notify();

        setTimeout(() => {
            this.isRolling = false;
            const shuffled = [...pool].sort(() => Math.random() - 0.5);
            this.winners = shuffled.slice(0, Math.min(count, shuffled.length));
            this.notify();

            if (this.winners.length > 0 && this.bot.chat && this.bot.chat.connected) {
                const names = this.winners.map(w => w.nickname).join(', ');
                this.bot.chat.sendChat(`🎉 [당첨자 발표] ${names}님, 축하드립니다!`);
            }
        }, 3000);
    }

    public reset() {
        this.candidates.clear();
        this.winners = [];
        this.isRolling = false;
        this.isActive = false;
        this.notify();
    }

    public getState() {
        return {
            candidatesCount: this.candidates.size,
            candidates: Array.from(this.candidates.values()).reverse(), // 명단 배열화
            settings: this.settings,
            isRolling: this.isRolling,
            isActive: this.isActive,
            winners: this.winners
        };
    }
}
