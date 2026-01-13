import { ChzzkChat, ChatEvent } from 'chzzk';
import { VariableProcessor } from './VariableProcessor';
import { BotInstance } from './BotInstance';

export interface Command { 
    id?: string;
    triggers: string[]; 
    response: string; 
    enabled: boolean; 
    state: { 
        totalCount: number; 
        userCounts: { [userIdHash: string]: number }; 
    }; 
}

/**
 * CommandManager: 커스텀 명령어의 생성, 삭제, 실행을 담당합니다.
 * 다양한 트리거 방식({any}, {editor} 등)을 지원합니다.
 */
export class CommandManager {
    private commands: Command[] = [];
    private variableProcessor: VariableProcessor;
    private onStateChangeCallback: () => void = () => {};
    private triggerCache: Set<string> = new Set();

    constructor(private bot: BotInstance, initialCommands: any[]) {
        this.variableProcessor = new VariableProcessor(bot as any);
        this.commands = (initialCommands || []).map(c => ({
            ...c,
            triggers: Array.isArray(c.triggers) ? c.triggers : [c.trigger],
            state: c.state || { totalCount: 0, userCounts: {} }
        }));
        this.rebuildTriggerCache();
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
    }

    private rebuildTriggerCache() {
        this.triggerCache.clear();
        for (const cmd of this.commands) {
            if (cmd.enabled) {
                cmd.triggers.forEach(t => this.triggerCache.add(t));
            }
        }
    }

    /**
     * 특정 메시지가 명령어 트리거에 해당하는지 확인
     */
    public hasCommand(message: string): boolean {
        if (!message) return false;
        const firstWord = message.trim().split(' ')[0];
        return this.triggerCache.has(firstWord);
    }

    /**
     * 명령어 추가 (대시보드 요청)
     */
    public addCommand(trigger: string, response: string): boolean {
        const triggers = trigger.split('/').map(t => t.trim()).filter(Boolean);
        if (triggers.length === 0) return false;

        const newCmd: Command = {
            id: `cmd_${Date.now()}`,
            triggers,
            response,
            enabled: true,
            state: { totalCount: 0, userCounts: {} }
        };

        this.commands.push(newCmd);
        this.rebuildTriggerCache();
        this.notify();
        return true;
    }

    /**
     * 명령어 제거
     */
    public removeCommand(trigger: string): boolean {
        const initialLen = this.commands.length;
        this.commands = this.commands.filter(c => !c.triggers.includes(trigger));
        
        if (this.commands.length < initialLen) {
            this.rebuildTriggerCache();
            this.notify();
            return true;
        }
        return false;
    }

    public getCommands(): Command[] {
        return this.commands;
    }

    /**
     * 명령어 실행
     */
    public async executeCommand(chat: ChatEvent, chzzkChat: ChzzkChat): Promise<void> {
        const msg = chat.message.trim();
        const firstWord = msg.split(' ')[0];

        const command = this.commands.find(c => c.enabled && c.triggers.includes(firstWord));
        if (!command) return;

        // 1. 통계 업데이트
        command.state.totalCount++;
        const userId = chat.profile.userIdHash;
        command.state.userCounts[userId] = (command.state.userCounts[userId] || 0) + 1;

        // 2. 변수 처리 및 전송
        try {
            const processedMsg = await this.variableProcessor.process(command.response, { 
                chat, 
                commandState: command.state 
            });
            await chzzkChat.sendChat(processedMsg);
            this.notify();
        } catch (err) {
            console.error(`[CommandManager] Execution error for ${firstWord}:`, err);
        }
    }
}
