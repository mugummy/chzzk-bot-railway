import { ChatEvent, ChzzkChat } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface Participant {
    userIdHash: string;
    nickname: string;
    joinedAt: number;
}

export class ParticipationManager {
    private queue: Participant[] = [];
    private activeParticipants: Participant[] = [];
    private isActive: boolean = false;
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
        this.bot.saveAll();
    }

    public getState() {
        return {
            queue: this.queue,
            participants: this.activeParticipants,
            isParticipationActive: this.isActive,
            maxParticipants: this.maxParticipants
        };
    }

    public startParticipation() { 
        this.isActive = true; 
        this.notify();
        const cmd = this.bot.settings.getSettings().participationCommand;
        if (this.bot.chat) this.bot.chat.sendChat(`📢 시청자 참여 모집이 시작되었습니다! ('${cmd} 참여' 입력)`);
    }

    public stopParticipation() { 
        this.isActive = false; 
        this.notify();
        if (this.bot.chat) this.bot.chat.sendChat('⛔ 시청자 참여 모집이 마감되었습니다.');
    }

    public updateMax(count: number) { this.maxParticipants = count; this.notify(); }

    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat) {
        // [핵심] 항상 최신 설정값을 가져와서 사용
        const prefix = (this.bot.settings.getSettings().participationCommand || '!시참').trim();
        const msg = chat.message.trim();

        // 1. 단순 접두사 입력 -> 안내
        if (msg === prefix) {
            return chzzkChat.sendChat(
                `📢 [참여 안내] '${prefix} 참여' 입력 시 대기열 등록! (현재: ${this.activeParticipants.length}/${this.maxParticipants})`
            );
        }

        // 2. 참여 신청
        if (msg === `${prefix} 참여`) {
            if (!this.isActive) return chzzkChat.sendChat('⛔ 현재는 참여 모집 중이 아닙니다.');
            
            const userId = chat.profile.userIdHash;
            if (this.queue.some(p => p.userIdHash === userId) || this.activeParticipants.some(p => p.userIdHash === userId)) {
                return chzzkChat.sendChat(`⚠️ ${chat.profile.nickname}님은 이미 등록되어 있습니다.`);
            }

            if (this.activeParticipants.length >= this.maxParticipants) {
                return chzzkChat.sendChat(`❌ 정원이 가득 찼습니다.`);
            }

            this.queue.push({ userIdHash: userId, nickname: chat.profile.nickname, joinedAt: Date.now() });
            this.notify();
            return chzzkChat.sendChat(`✅ ${chat.profile.nickname}님, 대기열에 등록되었습니다!`);
        }

        // 3. 현황 확인
        if (msg === `${prefix} 현황`) {
            return chzzkChat.sendChat(`👥 참여: ${this.activeParticipants.length}/${this.maxParticipants}명 | 대기: ${this.queue.length}명`);
        }

        // 4. 대기열 확인
        if (msg === `${prefix} 대기열`) {
            if (this.queue.length === 0) return chzzkChat.sendChat('📜 대기열 없음');
            const list = this.queue.slice(0, 5).map((p, i) => `${i+1}. ${p.nickname}`).join(', ');
            return chzzkChat.sendChat(`📜 대기열: ${list}`);
        }
    }

    public moveToParticipants(userIdHash: string) {
        const index = this.queue.findIndex(p => p.userIdHash === userIdHash);
        if (index > -1) {
            const p = this.queue.splice(index, 1)[0];
            this.activeParticipants.push(p);
            this.notify();
        }
    }

    public removeUser(userIdHash: string) {
        this.queue = this.queue.filter(p => p.userIdHash !== userIdHash);
        this.activeParticipants = this.activeParticipants.filter(p => p.userIdHash !== userIdHash);
        this.notify();
    }

    public clearAllData() {
        this.queue = [];
        this.activeParticipants = [];
        this.notify();
    }
}
