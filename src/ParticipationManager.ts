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

    public startParticipation() { this.isActive = true; this.notify(); }
    public stopParticipation() { this.isActive = false; this.notify(); }
    public updateMax(count: number) { this.maxParticipants = count; this.notify(); }

    /**
     * [수정된 로직]
     * Prefix: !시참 (고정 또는 설정 가능하나 보통 고정)
     * Command: 대시보드에서 설정한 참여 키워드 (예: "참여", "손", "ㄱㄱ")
     */
    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat) {
        const settings = this.bot.settings.getSettings();
        const keyword = settings.participationCommand || '참여'; // 대시보드에서 설정한 키워드
        const prefix = '!시참'; // 고정 접두사 (필요시 이것도 설정 가능하게 변경 가능)
        
        const msg = chat.message.trim();
        
        // 1. 단순 접두사 입력 -> 안내
        if (msg === prefix) {
            return chzzkChat.sendChat(
                `📢 [참여 안내] '${prefix} ${keyword}' 입력 시 대기열 등록! (현재: ${this.activeParticipants.length}/${this.maxParticipants})`
            );
        }

        // 2. 실제 참여 시도 (!시참 키워드)
        if (msg === `${prefix} ${keyword}`) {
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

        // 3. 현황 및 대기열 확인
        if (msg === `${prefix} 현황`) {
            return chzzkChat.sendChat(`👥 참여: ${this.activeParticipants.length}명 / 대기: ${this.queue.length}명`);
        }
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
