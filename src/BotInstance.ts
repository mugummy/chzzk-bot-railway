import { ChzzkClient, ChzzkChat, ChatEvent, DonationEvent } from 'chzzk';
import { CommandManager } from './CommandManager';
import { SongManager } from './SongManager';
import { VoteManager } from './VoteManager';
import { DataManager } from './DataManager';
import { PointManager } from './PointManager';
import { GreetManager } from './GreetManager';
import { SettingsManager } from './SettingsManager';
import { CounterManager } from './CounterManager';
import { MacroManager } from './MacroManager';
import { ParticipationManager } from './ParticipationManager';
import { DrawManager } from './DrawManager';
import { RouletteManager } from './RouletteManager';

/**
 * BotInstance: 개별 채널의 봇 로직을 독립적으로 수행하는 클래스
 */
export class BotInstance {
    private client: ChzzkClient;
    public chat: ChzzkChat | null = null;
    private botUserIdHash: string | null = null;

    // Services (Managers)
    public commands!: CommandManager;
    public songs!: SongManager;
    public votes!: VoteManager;
    public points!: PointManager;
    public greet!: GreetManager;
    public settings!: SettingsManager;
    public counters!: CounterManager;
    public macros!: MacroManager;
    public participation!: ParticipationManager;
    public draw!: DrawManager;
    public roulette!: RouletteManager;

    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private channelId: string, nidAuth: string, nidSes: string) {
        this.client = new ChzzkClient({ nidAuth, nidSession: nidSes });
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify(type: string, payload: any) {
        this.onStateChangeCallback(type, payload);
        this.saveAll(); 
    }

    public async setup() {
        const data = await DataManager.loadData(this.channelId);

        // 매니저 초기화 및 상태 변경 감지 연결 (완벽한 동기화)
        this.settings = new SettingsManager(data.settings);
        this.settings.setOnStateChangeListener(() => this.notify('settingsUpdate', this.settings.getSettings()));

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

        this.votes = new VoteManager(this as any);
        if (data.votes?.[0]) this.votes.setCurrentVote(data.votes[0]);
        this.votes.setOnStateChangeListener(() => this.notify('voteStateUpdate', this.votes.getState()));

        this.draw = new DrawManager(this as any, []);
        this.draw.setOnStateChangeListener(() => this.notify('drawStateUpdate', this.draw.getState()));

        this.roulette = new RouletteManager(this as any, []);
        this.roulette.setOnStateChangeListener(() => this.notify('rouletteStateUpdate', this.roulette.getState()));

        this.participation = new ParticipationManager(this as any, data.participants);
        this.participation.setOnStateChangeListener(() => this.notify('participationStateUpdate', this.participation.getState()));

        // 치지직 접속 로직
        const live = await this.client.live.detail(this.channelId);
        if (!live?.chatChannelId) throw new Error('Chat Channel ID Not Found');

        this.chat = this.client.chat({ channelId: this.channelId, chatChannelId: live.chatChannelId });
        this.chat.on('chat', (chat) => this.handleChat(chat));
        this.chat.on('donation', (donation) => this.handleDonation(donation));
        
        this.chat.on('connect', async () => {
            const self = await this.chat?.selfProfile();
            this.botUserIdHash = self?.userIdHash || null;
            this.macros.setChatClient(this.chat!); // 매크로에 채팅 클라이언트 주입
        });

        await this.chat.connect();
    }

    private async handleChat(chat: ChatEvent) {
        if (!this.settings.getSettings().chatEnabled) return;
        if (chat.profile.userIdHash === this.botUserIdHash) return;

        await this.greet.handleChat(chat, this.chat!);
        this.points.awardPoints(chat, this.settings.getSettings());
        await this.votes.handleChat(chat);
        this.draw.handleChat(chat);

        const msg = chat.message.trim();
        if (msg.startsWith('!')) {
            const cmd = msg.split(' ')[0];
            if (['!노래', '!신청', '!스킵'].includes(cmd)) await this.songs.handleCommand(chat, this.chat!, this.settings.getSettings());
            else if (cmd === '!시참') await this.participation.handleCommand(chat, this.chat!);
        }

        if (this.commands.hasCommand(msg)) await this.commands.executeCommand(chat, this.chat!);
        else if (this.counters.hasCounter(msg)) await this.counters.checkAndRespond(chat, this.chat!);
    }

    private async handleDonation(donation: DonationEvent) {
        await this.votes.handleDonation(donation);
        const youtubeUrlRegex = /(?:https?:\/\/)?[^\s]*youtu(?:be\.com\/watch\?v=|\.be\/)([a-zA-Z0-9_-]{11})(?:\S+)?/;
        const match = donation.message?.match(youtubeUrlRegex);
        if (match && match[0]) {
            try { await this.songs.addSongFromDonation(donation, match[0], this.settings.getSettings()); } catch(e) {}
        }
    }

    public async saveAll() {
        await DataManager.saveData(this.channelId, {
            settings: this.settings.getSettings(),
            commands: this.commands.getCommands(),
            counters: this.counters.getCounters(),
            macros: this.macros.getMacros(),
            points: this.points.getPointsData(),
            songQueue: this.songs.getData().songQueue,
            greetData: this.greet.getData(),
            votes: [this.votes.getState().currentVote],
            participants: this.participation.getState()
        });
    }

    public async disconnect() {
        if (this.chat) {
            this.macros.stopAllMacros();
            await this.chat.disconnect();
            this.chat = null;
        }
    }

    public getChannelId() { return this.channelId; }
    public getStatus() { return { connected: this.chat?.connected || false, channelId: this.channelId }; }
}