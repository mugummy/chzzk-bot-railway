import { ChatEvent, ChzzkChat } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface Participant {
    userIdHash: string;
    nickname: string;
    joinedAt: number;
}

/**
 * ParticipationManager: !시참 명령어를 체계적으로 관리합니다.
 */
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
     * [핵심] 명령어 핸들러 (!시참 서브 명령어 처리)
     */
    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat) {
        const settings = this.bot.settings.getSettings();
        const prefix = settings.participationCommand || '!시참';
        
        const msg = chat.message.trim();
        const parts = msg.split(' ');
        const cmd = parts[0];
        const subCmd = parts[1];

        // 1. 접두사만 입력한 경우 (!시참) -> 도움말 출력
        if (msg === prefix) {
            return chzzkChat.sendChat(
                `📢 [참여 안내] '${prefix} 참여' - 등록 / '${prefix} 현황' - 인원 확인 / '${prefix} 대기열' - 순서 확인`
            );
        }

        // 2. 참여 신청 (!시참 참여)
        if (msg === `${prefix} 참여`) {
            if (!this.isActive) return chzzkChat.sendChat('⛔ 현재는 참여 모집 중이 아닙니다.');
            
            const userId = chat.profile.userIdHash;
            if (this.queue.some(p => p.userIdHash === userId) || this.activeParticipants.some(p => p.userIdHash === userId)) {
                return chzzkChat.sendChat(`⚠️ ${chat.profile.nickname}님은 이미 등록되어 있습니다.`);
            }

            if (this.activeParticipants.length >= this.maxParticipants) {
                return chzzkChat.sendChat(`❌ 정원이 가득 찼습니다. (${this.activeParticipants.length}/${this.maxParticipants})`);
            }

            this.queue.push({ userIdHash: userId, nickname: chat.profile.nickname, joinedAt: Date.now() });
            this.notify();
            return chzzkChat.sendChat(`✅ ${chat.profile.nickname}님, 대기열에 등록되었습니다! (대기: ${this.queue.length}번)`);
        }

        // 3. 현황 확인 (!시참 현황)
        if (msg === `${prefix} 현황`) {
            return chzzkChat.sendChat(`👥 현재 참여 인원: ${this.activeParticipants.length}명 / 대기 중: ${this.queue.length}명`);
        }

        // 4. 대기열 확인 (!시참 대기열)
        if (msg === `${prefix} 대기열`) {
            if (this.queue.length === 0) return chzzkChat.sendChat('📜 현재 대기 중인 시청자가 없습니다.');
            const list = this.queue.slice(0, 5).map((p, i) => `${i+1}. ${p.nickname}`).join(', ');
            return chzzkChat.sendChat(`📜 대기열 명단: ${list} ${this.queue.length > 5 ? '...' : ''}`);
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