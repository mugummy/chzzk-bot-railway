import { ChzzkChat, ChatEvent } from 'chzzk';
import { VariableProcessor } from './VariableProcessor';
import { ChatBot } from './Bot';

export interface Command { 
    id?: string;
    triggers?: string[]; // 새로운 방식 (배열)
    trigger?: string;    // 이전 방식 (단일 문자열) - 호환성을 위해 유지
    response: string; 
    enabled: boolean; 
    state: { 
        editorValue?: string; 
        totalCount?: number; 
        userCounts?: { [userIdHash: string]: number }; 
    }; 
}
export class CommandManager {
    private commands: Command[] = [];
    private variableProcessor: VariableProcessor;
    private bot: ChatBot;
    // 빠른 룩업을 위한 트리거 캐시
    private triggerCache: Set<string> = new Set();
    private anyTriggerPrefixes: string[] = [];

    constructor(bot: ChatBot, initialCommands: Command[]) {
        this.bot = bot;
        this.variableProcessor = new VariableProcessor(bot);
        if (initialCommands && initialCommands.length > 0) {
            this.commands = initialCommands;
        } else {
            this.commands.push({ triggers: ['!핑', '!pong'], response: '퐁!', enabled: true, state: { totalCount: 0, userCounts: {} } });
        }
        this.rebuildTriggerCache();
    }

    // 트리거 캐시 재구성
    private rebuildTriggerCache(): void {
        this.triggerCache.clear();
        this.anyTriggerPrefixes = [];
        for (const cmd of this.commands) {
            if (!cmd.enabled) continue;
            const triggers = cmd.triggers || (cmd.trigger ? [cmd.trigger] : []);
            for (const t of triggers) {
                if (t.endsWith('{any}')) {
                    this.anyTriggerPrefixes.push(t.replace('{any}', ''));
                } else {
                    this.triggerCache.add(t);
                }
            }
        }
    }

    // 메시지가 등록된 명령어인지 빠르게 확인
    public hasCommand(message: string): boolean {
        if (!message) return false;
        const firstWord = message.trim().split(' ')[0];
        // 정확한 트리거 매칭
        if (this.triggerCache.has(firstWord)) return true;
        // {any} 패턴 매칭
        for (const prefix of this.anyTriggerPrefixes) {
            if (message.includes(prefix)) return true;
        }
        return false;
    }
    private saveData() { this.bot.saveAllData(); }
    public addCommand(triggers: string, response: string): boolean { 
        const triggerArray = triggers.split('/').map(t => t.trim()).filter(Boolean); 
        if (triggerArray.length === 0) {
            console.log('[CommandManager] No valid triggers provided');
            return false; 
        }
        
        // Check if any trigger already exists
        const existingTriggers = this.commands.flatMap(c => c.triggers || [c.trigger]).filter(Boolean);
        const hasConflict = triggerArray.some(trigger => existingTriggers.includes(trigger));
        
        if (hasConflict) {
            console.log(`[CommandManager] Trigger conflict detected for: ${triggerArray.join(', ')}`);
            return false;
        }
        
        const newCommand: Command = {
            id: `cmd_${Date.now()}_${triggerArray[0]?.replace('!', '')}`,
            triggers: triggerArray, 
            response, 
            enabled: true, 
            state: { totalCount: 0, userCounts: {} }
        };
        
        this.commands.push(newCommand);
        this.rebuildTriggerCache();
        this.saveData();
        return true;
    }
    public updateCommand(oldTrigger: string, newTriggers: string, newResponse: string, newEnabled: boolean): boolean {
        const command = this.commands.find(c => {
            const triggers = c.triggers || (c.trigger ? [c.trigger] : []);
            return triggers.includes(oldTrigger);
        });

        if (command) {
            command.triggers = newTriggers.split('/').map(t => t.trim()).filter(Boolean);
            command.response = newResponse;
            command.enabled = newEnabled;
            if (command.triggers.length > 0) {
                command.trigger = command.triggers[0];
            }
            this.rebuildTriggerCache();
            this.saveData();
            return true;
        }
        return false;
    }
    public removeCommand(trigger: string): boolean {
        const initialLength = this.commands.length;
        const trimmedTrigger = trigger.trim();

        let commandIndexToRemove = -1;
        for (let i = 0; i < this.commands.length; i++) {
            const command = this.commands[i];
            const triggers = command.triggers || (command.trigger ? [command.trigger] : []);
            if (triggers.some(t => t.trim() === trimmedTrigger)) {
                commandIndexToRemove = i;
                break;
            }
        }

        if (commandIndexToRemove !== -1) {
            this.commands.splice(commandIndexToRemove, 1);
            this.rebuildTriggerCache();
            this.saveData();
            return true;
        }
        return false;
    }
    public getCommands(): Command[] { 
        return this.commands.map((command, index) => {
            // triggers 배열이 없으면 trigger 속성에서 가져오기
            const triggers = command.triggers || (command.trigger ? [command.trigger] : []);
            return {
                ...command,
                id: command.id || `cmd_${index}_${triggers[0]?.replace('!', '') || 'unknown'}`,
                triggers: triggers
            };
        });
    }
    public async executeCommand(chat: ChatEvent, chzzkChat: ChzzkChat): Promise<void> {
        if (chat.hidden || !chat.message) return; 
        const messageParts = chat.message.trim().split(' '); 
        const firstWord = messageParts[0];

        // Find matched command
        let command: Command | undefined;
        let matchedTrigger: string | undefined;

        for (const cmd of this.commands) {
            if (!cmd.enabled) continue;
            
            const triggers = cmd.triggers || (cmd.trigger ? [cmd.trigger] : []);
            
            for (const t of triggers) {
                if (t.endsWith('{any}')) {
                    const realTrigger = t.replace('{any}', '');
                    if (chat.message.includes(realTrigger)) {
                        command = cmd;
                        matchedTrigger = t;
                        break;
                    }
                } else {
                    if (t === firstWord) {
                        command = cmd;
                        matchedTrigger = t;
                        break;
                    }
                }
            }
            if (command) break;
        }
        
        if (!command) return;
        
        command.state.totalCount = (command.state.totalCount || 0) + 1; 
        command.state.userCounts = command.state.userCounts || {}; 
        command.state.userCounts[chat.profile.userIdHash] = (command.state.userCounts[chat.profile.userIdHash] || 0) + 1; 
        
        // {editor} logic: capture arguments if present
        if (command.response.includes('{editor}')) { 
            // For exact match commands, arguments are the rest of the message
            if (matchedTrigger && !matchedTrigger.endsWith('{any}')) {
                const newEditorValue = messageParts.slice(1).join(' '); 
                if (newEditorValue) command.state.editorValue = newEditorValue; 
            }
        } 
        
        const responseText = await this.variableProcessor.process(command.response, { chat, commandState: command.state });
        chzzkChat.sendChat(responseText);
        this.saveData();
    }
}
