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

export class BotInstance {
    private client: ChzzkClient;
    public chat: ChzzkChat | null = null;
    private botUserIdHash: string | null = null;

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

    private notify(type: string, payload: any) { this.onStateChangeCallback(type, payload); }

    public async setup() {
        const data = await DataManager.loadData(this.channelId);

        this.settings = new SettingsManager(data.settings);
        this.commands = new CommandManager(this as any, data.commands);
        this.counters = new CounterManager(this as any, data.counters);
        this.macros = new MacroManager(this as any, data.macros);
        this.songs = new SongManager(this as any, data);
        this.points = new PointManager(data.points);
        this.greet = new GreetManager(this as any, data.greetData);
        this.votes = new VoteManager(this as any);
        if (data.votes?.[0]) this.votes.setCurrentVote(data.votes[0]);
        this.draw = new DrawManager(this as any, []);
        this.roulette = new RouletteManager(this as any, []);
        this.participation = new ParticipationManager(this as any, data.participants);

        try {
            const live = await this.client.live.detail(this.channelId);
            if (!live?.chatChannelId) throw new Error('Chat ID Missing');

            this.chat = this.client.chat({ channelId: this.channelId, chatChannelId: live.chatChannelId });
            
            this.chat.on('chat', (chat) => this.handleChat(chat));
            this.chat.on('donation', (donation) => this.handleDonation(donation));
            
            this.chat.on('connect', async () => {
                try {
                    const self = await this.chat?.selfProfile();
                    this.botUserIdHash = self?.userIdHash || null;
                    this.macros.setChatClient(this.chat!);
                } catch (e) {
                    console.error('[BotInstance] Auth Error: NID_AUTH/SES is invalid');
                    this.notify('error', '봇 로그인이 실패했습니다. 환경변수를 확인하세요.');
                }
            });

            await this.chat.connect();
        } catch (err) {
            console.error('[BotInstance] Connection Failed:', err);
        }
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
        const match = donation.message?.match(/(?:https?:\/\/)?(?:www\.)?youtu\.?be(?:\.com\/watch\?v=|\/)([a-zA-Z0-9_-]{11})/);
        if (match) { try { await this.songs.addSongFromDonation(donation, match[0], this.settings.getSettings()); } catch(e) {} }
    }

    public async saveAll() {
        await DataManager.saveData(this.channelId, { settings: this.settings.getSettings(), commands: this.commands.getCommands(), counters: this.counters.getCounters(), macros: this.macros.getMacros(), points: this.points.getPointsData(), songQueue: this.songs.getData().songQueue, greetData: this.greet.getData(), votes: [this.votes.getState().currentVote], participants: this.participation.getState() });
    }

    public async disconnect() { if (this.chat) { this.macros.stopAllMacros(); await this.chat.disconnect(); this.chat = null; } }
    public getChannelId() { return this.channelId; }
    public getStatus() { return { connected: this.chat?.connected || false, channelId: this.channelId }; }
}
