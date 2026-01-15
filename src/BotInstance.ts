import { ChzzkClient, ChzzkChat, ChatEvent, DonationEvent, LiveDetail, Channel } from 'chzzk';
import { CommandManager } from './CommandManager';
import { SongManager } from './SongManager';
import { DataManager } from './DataManager';
import { PointManager } from './PointManager';
import { GreetManager } from './GreetManager';
import { SettingsManager } from './SettingsManager';
import { CounterManager } from './CounterManager';
import { MacroManager } from './MacroManager';
import { ParticipationManager } from './ParticipationManager';
import { VoteManager } from './VoteManager';
import { DrawManager } from './DrawManager';
import { RouletteManager } from './RouletteManager';
import { OverlayManager } from './OverlayManager';

export class BotInstance {
    private client: ChzzkClient;
    public chat: ChzzkChat | null = null;
    private botUserIdHash: string | null = null;
    private isLoggedIn: boolean = false;
    private livePollingTimer: NodeJS.Timeout | null = null;
    public liveDetail: LiveDetail | null = null;
    public channel: Channel | null = null;
    private wsBroadcastCallback: (type: string, payload: any) => void = () => {};

    public commands!: CommandManager;
    public songs!: SongManager;
    public points!: PointManager;
    public greet!: GreetManager;
    public settings!: SettingsManager;
    public counters!: CounterManager;
    public macros!: MacroManager;
    public participation!: ParticipationManager;
    public vote!: VoteManager;
    public draw!: DrawManager;
    public roulette!: RouletteManager;
    public overlayManager!: OverlayManager;

    private onStateChangeCallback: (type: string, payload: any) => void = () => {};
    private onChatCallback: (chat: ChatEvent) => void = () => {};

    constructor(private channelId: string, nidAuth: string, nidSes: string) {
        this.client = new ChzzkClient({ nidAuth, nidSession: nidSes });
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) { this.onStateChangeCallback = callback; }
    public setOnChatListener(callback: (chat: ChatEvent) => void) { this.onChatCallback = callback; }
    public setBroadcastCallback(callback: (type: string, payload: any) => void) { this.wsBroadcastCallback = callback; }
    
    public broadcast(type: string, payload: any) {
        this.wsBroadcastCallback(type, payload);
    }

    private notify(type: string, payload: any) { this.onStateChangeCallback(type, payload); }

    public async setup() {
        const data = await DataManager.loadData(this.channelId);
        this.settings = new SettingsManager(data.settings);
        this.settings.setOnStateChangeListener(() => { this.notify('settingsUpdate', this.settings.getSettings()); this.saveAll(); });
        this.commands = new CommandManager(this as any, data.commands);
        this.commands.setOnStateChangeListener(() => this.notify('commandsUpdate', this.commands.getCommands()));
        this.counters = new CounterManager(this as any, data.counters);
        this.counters.setOnStateChangeListener(() => this.notify('countersUpdate', this.counters.getCounters()));
        this.macros = new MacroManager(this as any, data.macros);
        this.macros.setOnStateChangeListener(() => this.notify('macrosUpdate', this.macros.getMacros()));
        this.songs = new SongManager(this as any, data);
        this.songs.setOnStateChangeListener(() => this.notify('songStateUpdate', this.songs.getState()));
        this.points = new PointManager(data.points);
        this.points.setOnStateChangeListener(() => this.notify('pointsUpdate', this.points.getPointsData()));
        this.greet = new GreetManager(this as any, data.greetData);
        this.greet.setOnStateChangeListener(() => this.notify('greetStateUpdate', this.greet.getState()));
        this.participation = new ParticipationManager(this as any, data.participants);
        this.participation.setOnStateChangeListener(() => this.notify('participationStateUpdate', this.participation.getState()));

        // [New Features]
        this.overlayManager = new OverlayManager(this);
        this.vote = new VoteManager(this);
        this.vote.setOnStateChangeListener((t, p) => this.notify(t, p));
        this.draw = new DrawManager(this);
        this.draw.setOnStateChangeListener((t, p) => this.notify(t, p));
        this.roulette = new RouletteManager(this);
        this.roulette.setOnStateChangeListener((t, p) => this.notify(t, p));

        try {
            await this.refreshLiveInfo();
            this.livePollingTimer = setInterval(() => this.refreshLiveInfo(), 30000);
            if (this.liveDetail?.chatChannelId) {
                this.chat = this.client.chat({ channelId: this.channelId, chatChannelId: this.liveDetail.chatChannelId });
                this.chat.on('chat', (chat) => this.handleChat(chat));
                this.chat.on('donation', (donation) => this.handleDonation(donation));
                this.chat.on('connect', async () => {
                    const self = await this.chat?.selfProfile();
                    this.botUserIdHash = self?.userIdHash || null;
                    this.isLoggedIn = true;
                    this.macros.setChatClient(this.chat!);
                });
                await this.chat.connect();
            }
        } catch (e) {}
    }

    public async refreshLiveInfo() { try { this.channel = await this.client.channel(this.channelId); this.liveDetail = await this.client.live.detail(this.channelId); } catch (e) {} }
    
    private async handleChat(chat: ChatEvent) {
        if (this.botUserIdHash && chat.profile.userIdHash === this.botUserIdHash) return;
        this.onChatCallback(chat);
        this.points.awardPoints(chat, this.settings.getSettings());
        
        // 투표 및 추첨 채팅 핸들링
        this.vote.handleChat(chat);
        this.draw.handleChat(chat);

        if (this.isLoggedIn && this.settings.getSettings().chatEnabled) {
            await this.greet.handleChat(chat, this.chat!);
            const msg = chat.message.trim();
            if (msg.startsWith('!')) {
                const cmd = msg.split(' ')[0];
                if (cmd === '!노래') await this.songs.handleCommand(chat, this.chat!, this.settings.getSettings());
                else if (cmd === '!시참') await this.participation.handleCommand(chat, this.chat!);
            }
            if (this.commands.hasCommand(msg)) await this.commands.executeCommand(chat, this.chat!);
            else if (this.counters.hasCounter(msg)) await this.counters.checkAndRespond(chat, this.chat!);
        }
    }

    private async handleDonation(donation: DonationEvent) {
        this.songs.addSongFromDonation(donation, donation.message || '', this.settings.getSettings());
        this.vote.handleDonation(donation);
        // 추첨용 후원 로그 저장 (DataManager 혹은 직접 Supabase)
        // 여기서는 간단히 로그만 남김, 실제로는 DrawManager에서 읽어감
        await DataManager.logDonation(this.channelId, donation);
    }

    public getChannelInfo() { return { channelId: this.channelId, channelName: this.channel?.channelName || "정보 없음", channelImageUrl: this.channel?.channelImageUrl || "", followerCount: this.channel?.followerCount || 0 }; }
    public getLiveStatus() { return { liveTitle: this.liveDetail?.liveTitle || "오프라인", status: this.liveDetail?.status || "CLOSE", concurrentUserCount: this.liveDetail?.concurrentUserCount || 0, category: this.liveDetail?.liveCategoryValue || "미지정" }; }
    public getChannelId() { return this.channelId; }

    public async saveAll() { 
        await DataManager.saveData(this.channelId, { 
            settings: this.settings.getSettings(), 
            commands: this.commands.getCommands(), 
            counters: this.counters.getCounters(), 
            macros: this.macros.getMacros(), 
            points: this.points.getPointsData(), 
            songQueue: this.songs.getData().songQueue, 
            currentSong: this.songs.getData().currentSong, 
            greetData: this.greet.getData(), 
            participants: this.participation.getState()
        }); 
    }

    public async disconnect() { if (this.livePollingTimer) clearInterval(this.livePollingTimer); if (this.chat) { this.macros.stopAllMacros(); await this.chat.disconnect(); this.chat = null; } }
}