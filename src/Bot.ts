// src/Bot.ts - Expert Controller with Greet Support

import { ChzzkClient, ChzzkChat, ChatEvent, LiveDetail, Channel } from 'chzzk';
import { config } from './config';
import { CommandManager } from './CommandManager';
import { CounterManager } from './CounterManager';
import { MacroManager } from './MacroManager';
import { DataManager } from './DataManager';
import { ParticipationManager } from './ParticipationManager';
import { SongManager } from './SongManager';
import { PointManager } from './PointManager';
import { SettingsManager, BotSettings, defaultSettings } from './SettingsManager';
import { VoteManager } from './VoteManager';
import { DrawManager } from './DrawManager';
import { RouletteManager } from './RouletteManager';
import { GreetManager } from './GreetManager'; // 신규

type StateListener = () => void;

export class ChatBot {
    private client: ChzzkClient;
    public chat: ChzzkChat | null = null;
    
    public commandManager!: CommandManager;
    public counterManager!: CounterManager;
    public macroManager!: MacroManager;
    public participationManager!: ParticipationManager;
    public songManager!: SongManager;
    public pointManager!: PointManager;
    public settingsManager!: SettingsManager;
    public voteManager!: VoteManager;
    public drawManager!: DrawManager;
    public rouletteManager!: RouletteManager;
    public greetManager!: GreetManager; // 신규
    
    public settings: BotSettings = defaultSettings;
    public overlaySettings: any = {};
    private channelId: string = '';
    private onChatCallback: ((chat: ChatEvent) => void) | null = null;
    private onConnectCallback: (() => void) | null = null;
    private onStateChangeCallbacks: { [key: string]: StateListener } = {};
    public liveDetail: LiveDetail | null = null;
    public channel: Channel | null = null;
    private botUserIdHash: string | null = null;

    constructor(private channelIdOrName: string) {
        this.client = new ChzzkClient({ nidAuth: config.nidAuth, nidSession: config.nidSes });
    }

    public async init(): Promise<void> {}

    private async loadChannelData(realChannelId: string) {
        const data = await DataManager.loadData(realChannelId);
        this.settingsManager = new SettingsManager(data.settings);
        this.settings = this.settingsManager.getSettings();
        this.overlaySettings = data.overlaySettings;

        this.commandManager = new CommandManager(this, data.commands);
        this.counterManager = new CounterManager(this, data.counters);
        this.macroManager = new MacroManager(this, data.macros);
        this.participationManager = new ParticipationManager(this, data.participants);
        this.songManager = new SongManager(this, data);
        this.pointManager = new PointManager(data.points);
        this.voteManager = new VoteManager(this, data.votes);
        this.drawManager = new DrawManager(this, []);
        this.rouletteManager = new RouletteManager(this, []);
        this.greetManager = new GreetManager(this, data.greetData); // 인사 매니저 초기화

        // Listeners
        this.participationManager.setOnStateChangeListener(() => this.notifyStateChange('participation'));
        this.songManager.setOnStateChangeListener(() => this.notifyStateChange('song'));
        this.voteManager.setOnStateChangeListener(() => this.notifyStateChange('vote'));
        this.drawManager.setOnStateChangeListener(() => this.notifyStateChange('draw'));
        this.rouletteManager.setOnStateChangeListener(() => this.notifyStateChange('roulette'));
        this.pointManager.setOnStateChangeListener(() => this.notifyStateChange('points'));
        this.commandManager.setOnStateChangeListener(() => this.notifyStateChange('commands'));
        this.macroManager.setOnStateChangeListener(() => this.notifyStateChange('macros'));
        this.counterManager.setOnStateChangeListener(() => this.notifyStateChange('counters'));
        this.greetManager.setOnStateChangeListener(() => this.notifyStateChange('greet'));
    }

    private notifyStateChange(type: string) { this.onStateChangeCallbacks[type]?.(); }
    public setOnStateChangeListener(type: string, listener: StateListener) { this.onStateChangeCallbacks[type] = listener; }
    public setOnChatListener(listener: (chat: ChatEvent) => void) { this.onChatCallback = listener; }
    
    public saveAllData(): void { 
        if (!this.channelId) return;
        DataManager.saveData(this.channelId, {
            ...this.songManager.getData(),
            commands: this.commandManager.getCommands(),
            counters: this.counterManager.getCounters(),
            macros: this.macroManager.getMacros(),
            points: this.pointManager.getPointsData(),
            settings: this.settings,
            votes: this.voteManager.getVotes(),
            participants: this.participationManager.getState(),
            overlaySettings: this.overlaySettings,
            greetData: this.greetManager.getData() // 인사 데이터 포함
        });
    }
    
    public updateSettings(newSettings: Partial<BotSettings>) { 
        this.settingsManager.updateSettings(newSettings); 
        this.settings = this.settingsManager.getSettings(); 
        this.saveAllData(); 
        this.notifyStateChange('settings');
    }
    
    public updateOverlaySettings(newSettings: any) {
        this.overlaySettings = { ...this.overlaySettings, ...newSettings };
        this.saveAllData();
        this.notifyStateChange('overlay');
    }

    public sendChat(message: string) { 
        if (this.settings.chatEnabled && this.chat?.connected) { 
            try { this.chat.sendChat(message); } catch (e) {}
        }
    }

    public async connect(): Promise<void> {
        try {
            if (/^[a-f0-9]{32}$/.test(this.channelIdOrName)) this.channelId = this.channelIdOrName;
            else {
                const search = await this.client.search.channels(this.channelIdOrName);
                if (!search.channels[0]) throw new Error('Channel Not Found');
                this.channelId = search.channels[0].channelId;
            }
            await this.loadChannelData(this.channelId);
            this.channel = await this.client.channel(this.channelId);
            this.liveDetail = await this.client.live.detail(this.channelId);
            if (!this.liveDetail?.chatChannelId) throw new Error('Chat ID Not Found');
            
            this.chat = this.client.chat({ channelId: this.channelId, chatChannelId: this.liveDetail.chatChannelId });
            this.macroManager.setChatClient(this.chat);
            
            this.chat.on('chat', async (chat: ChatEvent) => {
                if (!this.settings.chatEnabled || chat.profile.userIdHash === this.botUserIdHash) return;
                
                // 인사 로직 실행
                await this.greetManager.handleChat(chat, this.chat!);

                this.pointManager.awardPoints(chat, this.settings);
                this.drawManager.handleChat(chat);
                await this.voteManager.handleChat(chat);

                const msg = chat.message.trim();
                if (msg.startsWith('!')) {
                    const cmd = msg.split(' ')[0];
                    if (cmd === '!시참') await this.participationManager.handleCommand(chat, this.chat!);
                    else if (['!노래', '!노래신청', '!대기열', '!스킵', '!현재노래', '!다음곡'].includes(cmd)) this.songManager.handleCommand(chat, this.chat!, this.settings);
                    else if (cmd === '!포인트') this.pointManager.handleCommand(chat, this.chat!, this.settings);
                    else if (cmd === '!투표') await this.voteManager.handleCommand(chat, this.chat!);
                }
                if (this.commandManager.hasCommand(msg)) this.commandManager.executeCommand(chat, this.chat!);
                else if (this.counterManager.hasCounter(msg)) this.counterManager.checkAndRespond(chat, this.chat!);
            });

            this.chat.on('connect', async () => {
                const self = await this.chat?.selfProfile();
                this.botUserIdHash = self?.userIdHash || null;
                this.onConnectCallback?.();
            });

            await this.chat.connect();
        } catch (error) { console.error(`[Bot] Connect Failed:`, error); throw error; }
    }

    public async disconnect(): Promise<void> {
        if (this.chat) {
            this.macroManager.stopAllMacros();
            await this.chat.disconnect();
            this.chat = null;
        }
    }

    public getChannelInfo() { return this.channel ? { channelId: this.channelId, channelName: this.channel.channelName, channelImageUrl: this.channel.channelImageUrl, followerCount: this.channel.followerCount } : null; }
    public getLiveStatus() { return this.liveDetail ? { liveTitle: this.liveDetail.liveTitle, status: this.liveDetail.status, concurrentUserCount: this.liveDetail.concurrentUserCount, category: this.liveDetail.category } : null; }
    public isConnected(): boolean { return this.chat?.connected ?? false; }
}