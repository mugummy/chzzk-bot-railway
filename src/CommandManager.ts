import { ChzzkChat, ChatEvent } from 'chzzk';
import { VariableProcessor } from './VariableProcessor';
import { ChatBot } from './Bot';

export interface Command { 
    id?: string;
    triggers?: string[]; 
    trigger?: string;
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
    private onStateChangeCallback: () => void = () => {};
    private triggerCache: Set<string> = new Set();
    private anyTriggerPrefixes: string[] = [];

    constructor(bot: ChatBot, initialCommands: Command[]) {
        this.bot = bot;
        this.variableProcessor = new VariableProcessor(bot);
        this.commands = (initialCommands && initialCommands.length > 0) 
            ? initialCommands 
            : [{ triggers: ['!핑'], response: '퐁!', enabled: true, state: { totalCount: 0, userCounts: {} } }];
        this.rebuildTriggerCache();
    }

    public setOnStateChangeListener(callback: () => void): void {
        this.onStateChangeCallback = callback;
    }

    private notifyStateChange(): void {
        this.onStateChangeCallback();
        this.bot.saveAllData();
    }

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

    public hasCommand(message: string): boolean {
        if (!message) return false;
        const firstWord = message.trim().split(' ')[0];
        if (this.triggerCache.has(firstWord)) return true;
        for (const prefix of this.anyTriggerPrefixes) {
            if (message.includes(prefix)) return true;
        }
        return false;
    }

    public addCommand(triggers: string, response: string): boolean { 
        const triggerArray = triggers.split('/').map(t => t.trim()).filter(Boolean); 
        if (triggerArray.length === 0) return false;
        
        const newCommand: Command = {
            id: `cmd_${Date.now()}`,
            triggers: triggerArray, 
            response, 
            enabled: true, 
            state: { totalCount: 0, userCounts: {} }
        };
        
        this.commands.push(newCommand);
        this.rebuildTriggerCache();
        this.notifyStateChange();
        return true;
    }

    public removeCommand(trigger: string): boolean {
        const trimmedTrigger = trigger.trim();
        const initialLength = this.commands.length;
        this.commands = this.commands.filter(c => {
            const triggers = c.triggers || [c.trigger];
            return !triggers.some(t => t === trimmedTrigger);
        });

        if (this.commands.length < initialLength) {
            this.rebuildTriggerCache();
            this.notifyStateChange();
            return true;
        }
        return false;
    }

    public getCommands(): Command[] { 
        return this.commands.map((c, i) => ({
            ...c,
            id: c.id || `cmd_${i}`,
            triggers: c.triggers || [c.trigger || '']
        }));
    }

    public async executeCommand(chat: ChatEvent, chzzkChat: ChzzkChat): Promise<void> {
        if (chat.hidden || !chat.message || !this.bot.settings.chatEnabled) return; 
        const messageParts = chat.message.trim().split(' '); 
        const firstWord = messageParts[0];

        let command: Command | undefined;
        let matchedTrigger: string | undefined;

        for (const cmd of this.commands) {
            if (!cmd.enabled) continue;
            const triggers = cmd.triggers || [cmd.trigger];
            for (const t of triggers) {
                if (t?.endsWith('{any}')) {
                    if (chat.message.includes(t.replace('{any}', ''))) {
                        command = cmd; matchedTrigger = t; break;
                    }
                } else if (t === firstWord) {
                    command = cmd; matchedTrigger = t; break;
                }
            }
            if (command) break;
        }
        
        if (!command) return;
        
        command.state.totalCount = (command.state.totalCount || 0) + 1; 
        command.state.userCounts = command.state.userCounts || {}; 
        command.state.userCounts[chat.profile.userIdHash] = (command.state.userCounts[chat.profile.userIdHash] || 0) + 1; 
        
        if (command.response.includes('{editor}') && matchedTrigger && !matchedTrigger.endsWith('{any}')) {
            const newEditorValue = messageParts.slice(1).join(' '); 
            if (newEditorValue) command.state.editorValue = newEditorValue; 
        } 
        
        const responseText = await this.variableProcessor.process(command.response, { chat, commandState: command.state });
        chzzkChat.sendChat(responseText);
        this.notifyStateChange();
    }
}