import { ChatEvent, ChzzkChat } from 'chzzk';
import { ChatBot } from './Bot';
import { VariableProcessor } from './VariableProcessor';
import { DataManager } from './DataManager';

export interface Participant {
    userIdHash: string;
    nickname: string;
    joinTime?: number;
    participationCount?: number;  // 현재 세션에서의 참여 횟수
    totalCount?: number;          // 전체 누적 참여 횟수
}

export interface ParticipationHistoryEntry {
    nickname: string;
    count: number;
}

export class ParticipationManager {
    private queue: Participant[] = [];
    private participants: Participant[] = [];
    private maxParticipants: number = 10;
    private bot: ChatBot;
    private variableProcessor: VariableProcessor;
    private onStateChangeCallback: () => void = () => {};
    private isParticipationActive: boolean = false;
    // 현재 세션 참여 횟수 (시작~마감)
    private sessionParticipation: { [userIdHash: string]: { nickname: string; count: number } } = {};
    // 전체 누적 참여 횟수 (영구 저장)
    private userParticipationHistory: { [userIdHash: string]: { nickname: string; count: number } } = {};

    constructor(bot: ChatBot, initialData?: any) {
        this.bot = bot;
        this.variableProcessor = new VariableProcessor(bot);

        // 기존 데이터 로드
        if (initialData) {
            this.queue = initialData.queue || [];
            this.participants = initialData.participants || [];
            this.maxParticipants = initialData.maxParticipants || 10;
            this.isParticipationActive = initialData.isParticipationActive !== undefined ? initialData.isParticipationActive : false;
            // 기존 형식 호환 (숫자만 있던 경우 변환)
            if (initialData.userParticipationHistory) {
                for (const [key, val] of Object.entries(initialData.userParticipationHistory)) {
                    if (typeof val === 'number') {
                        this.userParticipationHistory[key] = { nickname: '알 수 없음', count: val };
                    } else if (val && typeof val === 'object') {
                        this.userParticipationHistory[key] = val as { nickname: string; count: number };
                    }
                }
            }
        }

        console.log(`[ParticipationManager] Initialized with ${this.queue.length} queued, ${this.participants.length} participants, active: ${this.isParticipationActive}`);
    }

    public setOnStateChangeListener(callback: () => void): void {
        this.onStateChangeCallback = callback;
    }

    private notifyStateChange(): void {
        console.log(`[ParticipationManager] ========== STATE CHANGE ==========`);
        // ... (logging omitted for brevity)
        this.onStateChangeCallback();
        this.bot.saveAllData(); // Ensure saveAllData includes userParticipationHistory
    }

    public getState() {
        // 전체 누적 랭킹 (상위 정렬)
        const totalRanking = Object.entries(this.userParticipationHistory)
            .map(([userIdHash, data]) => ({
                userIdHash,
                nickname: data.nickname,
                count: data.count
            }))
            .sort((a, b) => b.count - a.count);

        // 현재 세션 랭킹
        const sessionRanking = Object.entries(this.sessionParticipation)
            .map(([userIdHash, data]) => ({
                userIdHash,
                nickname: data.nickname,
                count: data.count
            }))
            .sort((a, b) => b.count - a.count);

        return {
            queue: this.queue,
            participants: this.participants,
            maxParticipants: this.maxParticipants,
            isParticipationActive: this.isParticipationActive,
            userParticipationHistory: this.userParticipationHistory,
            sessionParticipation: this.sessionParticipation,
            totalRanking: totalRanking,
            sessionRanking: sessionRanking
        };
    }

    public startParticipation(): void {
        console.log('[ParticipationManager] Starting participation - Clearing current participants and session counts');
        // 새로운 세션 시작 시 초기화
        this.participants = [];
        this.queue = [];
        this.sessionParticipation = {};  // 세션 카운트 초기화

        this.isParticipationActive = true;
        this.notifyStateChange();
    }

    public stopParticipation(): void {
        console.log('[ParticipationManager] Stopping participation - Session counts will be reset');
        this.isParticipationActive = false;
        // 마감 시 세션 카운트는 유지 (UI에서 볼 수 있도록), 다음 시작 시 초기화
        this.notifyStateChange();
    }

    public isActive(): boolean {
        return this.isParticipationActive;
    }

    public addToQueue(user: Participant): { success: boolean; message: string } {
        if (!this.isParticipationActive) return { success: false, message: "현재 참여를 받지 않고 있습니다." };
        if (this.queue.some(p => p.userIdHash === user.userIdHash)) return { success: false, message: "이미 대기열에 있습니다." };
        if (this.participants.some(p => p.userIdHash === user.userIdHash)) return { success: false, message: "이미 참여중입니다." };

        const totalCount = this.userParticipationHistory[user.userIdHash]?.count || 0;
        const sessionCount = this.sessionParticipation[user.userIdHash]?.count || 0;

        const participantWithTime: Participant = {
            userIdHash: user.userIdHash,
            nickname: user.nickname,
            joinTime: Date.now(),
            participationCount: sessionCount,
            totalCount: totalCount
        };

        // 자동 참여 로직: 최대 인원 미만이면 바로 참여
        if (this.participants.length < this.maxParticipants) {
            // 세션 참여 횟수 증가
            this.sessionParticipation[user.userIdHash] = {
                nickname: user.nickname,
                count: sessionCount + 1
            };
            // 전체 누적 참여 횟수 증가
            this.userParticipationHistory[user.userIdHash] = {
                nickname: user.nickname,
                count: totalCount + 1
            };

            participantWithTime.participationCount = sessionCount + 1;
            participantWithTime.totalCount = totalCount + 1;

            this.participants.push(participantWithTime);
            console.log(`[ParticipationManager] User directly added to participants: ${user.nickname} (session: ${sessionCount + 1}, total: ${totalCount + 1})`);
            
            // DB 기록 저장
            DataManager.saveParticipationHistory(this.bot.getChannelId(), user.userIdHash, user.nickname);
            
            this.notifyStateChange();
            return { success: true, message: "참여자로 등록되었습니다." };
        } else {
            // 대기열 추가
            this.queue.push(participantWithTime);
            console.log(`[ParticipationManager] User added to queue: ${user.nickname}`);
            this.notifyStateChange();
            return { success: true, message: "대기열에 추가되었습니다." };
        }
    }

    public removeFromQueue(userIdHash: string): void {
        console.log(`[ParticipationManager] Removing user from queue: ${userIdHash}`);
        const beforeSize = this.queue.length;
        this.queue = this.queue.filter(p => p.userIdHash !== userIdHash);
        console.log(`[ParticipationManager] Queue size: ${beforeSize} -> ${this.queue.length}`);
        this.notifyStateChange();
    }

    public clearQueue(): void {
        console.log('[ParticipationManager] Clearing queue');
        this.queue = [];
        this.notifyStateChange();
    }

    public clearAllData(): void {
        console.log('[ParticipationManager] Clearing all participation data');
        this.queue = [];
        this.participants = [];
        this.isParticipationActive = false;
        this.notifyStateChange();
    }

    public moveToParticipants(userIdHash: string): { success: boolean; message: string } {
        if (this.participants.length >= this.maxParticipants) {
            return { success: false, message: "참여 인원이 가득 찼습니다." };
        }

        const userIndex = this.queue.findIndex(p => p.userIdHash === userIdHash);
        if (userIndex === -1) {
            return { success: false, message: "대기열에 없는 유저입니다." };
        }

        const user = this.queue[userIndex];
        this.queue.splice(userIndex, 1);

        // 참여 횟수 증가
        const totalCount = this.userParticipationHistory[user.userIdHash]?.count || 0;
        const sessionCount = this.sessionParticipation[user.userIdHash]?.count || 0;

        this.sessionParticipation[user.userIdHash] = {
            nickname: user.nickname,
            count: sessionCount + 1
        };
        this.userParticipationHistory[user.userIdHash] = {
            nickname: user.nickname,
            count: totalCount + 1
        };

        user.participationCount = sessionCount + 1;
        user.totalCount = totalCount + 1;

        this.participants.push(user);

        console.log(`[ParticipationManager] User moved to participants: ${user.nickname} (session: ${sessionCount + 1}, total: ${totalCount + 1})`);
        
        // DB 기록 저장
        DataManager.saveParticipationHistory(this.bot.getChannelId(), user.userIdHash, user.nickname);

        this.notifyStateChange();
        return { success: true, message: "참여자로 이동했습니다." };
    }
    
    // ... (finishParticipation, clearParticipants, setMaxParticipants, handleCommand methods remain same)

    public finishParticipation(userIdHash: string): void {
        console.log(`[ParticipationManager] Finishing participation: ${userIdHash}`);
        const beforeSize = this.participants.length;
        this.participants = this.participants.filter(p => p.userIdHash !== userIdHash);
        console.log(`[ParticipationManager] Participants size: ${beforeSize} -> ${this.participants.length}`);
        this.notifyStateChange();
    }

    public clearParticipants(): void {
        console.log('[ParticipationManager] Clearing participants');
        this.participants = [];
        this.notifyStateChange();
    }

    public setMaxParticipants(count: number): void {
        if (count > 0) {
            console.log(`[ParticipationManager] Setting max participants: ${this.maxParticipants} -> ${count}`);
            this.maxParticipants = count;
            this.notifyStateChange();
        }
    }

    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat): Promise<void> {
        const message = chat.message.trim();
        const user: Participant = {
            userIdHash: chat.profile.userIdHash,
            nickname: chat.profile.nickname
        };

        console.log(`[ParticipationManager] ========== COMMAND HANDLER ==========`);
        console.log(`[ParticipationManager] Command: "${message}"`);
        console.log(`[ParticipationManager] User: ${user.nickname} (${user.userIdHash})`);
        console.log(`[ParticipationManager] Participation active: ${this.isParticipationActive}`);

        try {
            if (message === '!시참') {
                console.log(`[ParticipationManager] Handling help command`);
                await chzzkChat.sendChat("참여하시려면 '!시참 참여', 현재 상태를 보려면 '!시참 현황'을 입력해주세요.");
            }
            else if (message === '!시참 참여') {
                console.log(`[ParticipationManager] Handling join command`);
                
                const result = this.addToQueue(user);
                const responseText = await this.variableProcessor.process(`{user}님, ${result.message}`, { chat });
                await chzzkChat.sendChat(responseText);
                console.log(`[ParticipationManager] Sent response: ${responseText}`);
            }
            else if (message === '!시참 현황') {
                console.log(`[ParticipationManager] Handling status command`);
                const queueList = this.queue.map(p => p.nickname).join(', ');
                const participantList = this.participants.map(p => p.nickname).join(', ');
                const statusMessage = `[참여 현황] 참여중 (${this.participants.length}/${this.maxParticipants}): ${participantList || '없음'} / 대기중 (${this.queue.length}명): ${queueList || '없음'} / 상태: ${this.isParticipationActive ? '활성' : '비활성'}`;
                await chzzkChat.sendChat(statusMessage);
                console.log(`[ParticipationManager] Sent status: ${statusMessage}`);
            }
        } catch (error) {
            console.error(`[ParticipationManager] Error handling command:`, error);
        }

        console.log(`[ParticipationManager] ========== COMMAND HANDLER END ==========`);
    }
}