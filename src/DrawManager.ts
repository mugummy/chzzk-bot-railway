import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface DrawCandidate {
    userIdHash: string;
    nickname: string;
    source: 'chat' | 'donation' | 'vote';
}

export class DrawManager {
    private candidates: Map<string, DrawCandidate> = new Map();
    // 초기 설정값 통일
    private settings: any = { mode: 'chat', chatType: 'command', chatCommand: '!참가', donationType: 'all', donationAmount: 1000 };
    private isRolling: boolean = false;
    private isActive: boolean = false;
    private winners: DrawCandidate[] = [];
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialData?: any) {
        if (initialData) {
            this.isActive = initialData.isActive || false;
            this.settings = initialData.settings || this.settings;
            // 배열로 저장된 데이터를 다시 Map으로 복구
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
        this.bot.saveAll();
    }

    public startSession(settings: any) {
        this.candidates.clear();
        this.winners = [];
        this.isActive = true;
        this.isRolling = false;
        this.settings = { ...this.settings, ...settings };
        
        // [중요] 상태 변경 후 즉시 알림
        this.notify();
        
        if (this.bot.chat && this.bot.chat.connected) {
            let msg = `🎰 [추첨 모집 시작] `;
            if (this.settings.mode === 'chat') {
                msg += this.settings.chatType === 'any' ? "채팅창에 아무 말이나 입력하세요!" : `'${this.settings.chatCommand}' 입력 시 자동 응모!`;
            } else {
                msg += this.settings.donationType === 'all' ? "후원 시 자동 응모!" : `${this.settings.donationAmount}치즈 후원 시 자동 응모!`;
            }
            this.bot.chat.sendChat(msg);
        }
    }

    public endSession() {
        this.isActive = false;
        this.notify();
        if (this.bot.chat && this.bot.chat.connected) {
            this.bot.chat.sendChat(`⛔ [모집 마감] 총 ${this.candidates.size}명이 응모했습니다.`);
        }
    }

    public injectCandidatesFromVote(voters: any[]) {
        this.candidates.clear();
        voters.forEach(v => {
            this.candidates.set(v.userIdHash, { 
                userIdHash: v.userIdHash, 
                nickname: v.nickname, 
                source: 'vote' 
            });
        });
        this.isActive = false; // 투표자 추첨은 모집 단계 없음
        this.notify();
    }

    public handleChat(chat: ChatEvent) {
        if (!this.isActive || this.settings.mode !== 'chat' || this.isRolling) return;
        if (chat.profile.userIdHash === this.bot.getChannelId()) return;

        let isValid = false;
        const msg = chat.message.trim();
        
        if (this.settings.chatType === 'any') isValid = true;
        else if (this.settings.chatType === 'command' && msg === this.settings.chatCommand) isValid = true;

        if (isValid && !this.candidates.has(chat.profile.userIdHash)) {
            this.candidates.set(chat.profile.userIdHash, { 
                userIdHash: chat.profile.userIdHash, 
                nickname: chat.profile.nickname, 
                source: 'chat' 
            });
            this.notify(); // 명단 갱신 알림
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

        this.isActive = false; // 자동 마감
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
                this.bot.chat.sendChat(`🎉 [당첨자 발표] ${names} 축하드립니다!`);
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

    // [핵심] Map을 배열로 변환하여 전송 (JSON 직렬화 문제 해결)
    public getState() {
        return {
            candidatesCount: this.candidates.size,
            candidates: Array.from(this.candidates.values()).reverse(), // 전체 명단 전송
            settings: this.settings,
            isRolling: this.isRolling,
            isActive: this.isActive,
            winners: this.winners
        };
    }
}