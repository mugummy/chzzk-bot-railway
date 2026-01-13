import { ChatEvent, ChzzkChat } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface Participant {
    userIdHash: string;
    nickname: string;
    joinedAt: number;
}

/**
 * ParticipationManager: !시참 명령어를 통한 시청자 참여 대기열을 관리합니다.
 */
export class ParticipationManager {
    private queue: Participant[] = []; // 승인 대기 명단
    private activeParticipants: Participant[] = []; // 최종 참여 확정 명단
    private isActive: boolean = false; // 참여 모집 중 여부
    private maxParticipants: number = 10;
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialData?: any) {
        if (initialData) {
            this.queue = initialData.queue || [];
            this.activeParticipants = initialData.active || [];
            this.isActive = initialData.isActive || false;
            this.maxParticipants = initialData.max || 10;
        }
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
    }

    public getState() {
        return {
            queue: this.queue,
            participants: this.activeParticipants,
            isParticipationActive: this.isActive,
            maxParticipants: this.maxParticipants
        };
    }

    /**
     * 참여 모집 시작/종료 제어
     */
    public startParticipation() { this.isActive = true; this.notify(); }
    public stopParticipation() { this.isActive = false; this.notify(); }

    /**
     * 채팅 명령어 (!시참) 처리
     */
    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat) {
        if (!this.isActive) return;

        const userId = chat.profile.userIdHash;
        const nickname = chat.profile.nickname;

        // 이미 참여 중이거나 대기 중인지 확인
        if (this.queue.some(p => p.userIdHash === userId) || this.activeParticipants.some(p => p.userIdHash === userId)) {
            return; // 중복 신청 무시
        }

        if (this.activeParticipants.length >= this.maxParticipants) {
            return chzzkChat.sendChat(`❌ 참여 인원이 이미 가득 찼습니다. (최대 ${this.maxParticipants}명)`);
        }

        this.queue.push({ userIdHash: userId, nickname, joinedAt: Date.now() });
        this.notify();
        chzzkChat.sendChat(`✅ ${nickname}님, 참여 대기열에 등록되었습니다!`);
    }

    /**
     * 대기자 승인 (대시보드 액션)
     */
    public moveToParticipants(userIdHash: string) {
        const index = this.queue.findIndex(p => p.userIdHash === userIdHash);
        if (index > -1) {
            const p = this.queue.splice(index, 1)[0];
            this.activeParticipants.push(p);
            this.notify();
        }
    }

    /**
     * 특정 유저 제거
     */
    public removeUser(userIdHash: string) {
        this.queue = this.queue.filter(p => p.userIdHash !== userIdHash);
        this.activeParticipants = this.activeParticipants.filter(p => p.userIdHash !== userIdHash);
        this.notify();
    }

    /**
     * 모든 데이터 초기화
     */
    public clearAllData() {
        this.queue = [];
        this.activeParticipants = [];
        this.notify();
    }
}
