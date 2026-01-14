import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface DrawCandidate {
    userIdHash: string;
    nickname: string;
    source: 'chat' | 'donation' | 'vote';
    value?: number; // 후원 금액 등
}

export interface DrawSettings {
    mode: 'chat' | 'donation';
    chatType: 'any' | 'command';
    chatCommand: string;
    donationType: 'all' | 'specific';
    donationAmount: number;
}

export class DrawManager {
    private candidates: Map<string, DrawCandidate> = new Map();
    private settings: DrawSettings = {
        mode: 'chat',
        chatType: 'command',
        chatCommand: '!추첨',
        donationType: 'all',
        donationAmount: 1000
    };
    private isRolling: boolean = false;
    private winners: DrawCandidate[] = [];
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: BotInstance, initialData: any) {
        // 초기화 로직
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('drawStateUpdate', this.getState());
        // 추첨 데이터는 실시간성이 강해 DB에 매번 저장할 필요는 없으나, 필요시 저장
    }

    public startSession(keyword: string, settings: any) {
        this.candidates.clear();
        this.winners = [];
        this.settings = settings; // 대시보드 설정을 덮어씀
        this.notify();
        
        if (this.bot.chat) {
            let msg = `🎰 추첨 모집 시작! `;
            if (this.settings.mode === 'chat') {
                msg += this.settings.chatType === 'any' ? "아무 채팅이나 치면 참가!" : `'${this.settings.chatCommand}' 입력 시 참가!`;
            } else {
                msg += this.settings.donationType === 'all' ? "후원 시 자동 참가!" : `${this.settings.donationAmount}치즈 후원 시 참가!`;
            }
            this.bot.chat.sendChat(msg);
        }
    }

    public handleChat(chat: ChatEvent) {
        if (this.settings.mode !== 'chat' || this.isRolling) return;
        if (chat.profile.userIdHash === this.bot.getChannelId()) return; // 봇 제외

        let isValid = false;
        if (this.settings.chatType === 'any') isValid = true;
        else if (this.settings.chatType === 'command' && chat.message.trim() === this.settings.chatCommand) isValid = true;

        if (isValid) {
            this.candidates.set(chat.profile.userIdHash, {
                userIdHash: chat.profile.userIdHash,
                nickname: chat.profile.nickname,
                source: 'chat'
            });
            this.notify(); // 참가자 수 갱신을 위해 알림
        }
    }

    public handleDonation(donation: DonationEvent) {
        if (this.settings.mode !== 'donation' || this.isRolling) return;

        let isValid = false;
        if (this.settings.donationType === 'all') isValid = true;
        else if (this.settings.donationType === 'specific' && donation.payAmount === this.settings.donationAmount) isValid = true;

        if (isValid) {
            this.candidates.set(donation.profile.userIdHash, {
                userIdHash: donation.profile.userIdHash,
                nickname: donation.profile.nickname,
                source: 'donation',
                value: donation.payAmount
            });
            this.notify();
        }
    }

    // [핵심] 추첨 실행 (슬롯머신)
    public draw(count: number = 1) {
        const pool = Array.from(this.candidates.values());
        if (pool.length === 0) return { success: false, msg: '참가자가 없습니다.' };

        this.isRolling = true;
        this.notify(); // 슬롯머신 애니메이션 시작 신호

        // 3초 후 결과 발표
        setTimeout(() => {
            this.isRolling = false;
            // 중복 없이 랜덤 추출
            const shuffled = pool.sort(() => 0.5 - Math.random());
            this.winners = shuffled.slice(0, count);
            
            this.notify();
            if (this.bot.chat) {
                const names = this.winners.map(w => w.nickname).join(', ');
                this.bot.chat.sendChat(`🎉 축하합니다! 당첨자: [ ${names} ]`);
            }
        }, 3000);

        return { success: true, winners: [] }; // 결과는 비동기로 처리됨
    }

    public reset() {
        this.candidates.clear();
        this.winners = [];
        this.isRolling = false;
        this.notify();
    }

    public getState() {
        return {
            candidatesCount: this.candidates.size,
            // 보안상 전체 명단 대신 카운트만 보내거나, 필요시 명단 전송
            candidates: Array.from(this.candidates.values()).slice(-10), // 최근 10명만 미리보기
            settings: this.settings,
            isRolling: this.isRolling,
            winners: this.winners
        };
    }
}
