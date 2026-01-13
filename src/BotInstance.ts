import { ChzzkClient, ChzzkChat, ChatEvent, DonationEvent, LiveDetail, Channel } from 'chzzk';
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

    // 외부 연동용 공개 데이터
    public liveDetail: LiveDetail | null = null;
    public channel: Channel | null = null;

    // 매니저 객체들
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
    private onChatCallback: (chat: ChatEvent) => void = () => {};

    constructor(private channelId: string, nidAuth: string, nidSes: string) {
        this.client = new ChzzkClient({ nidAuth, nidSession: nidSes });
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    public setOnChatListener(callback: (chat: ChatEvent) => void) {
        this.onChatCallback = callback;
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
            this.channel = await this.client.channel(this.channelId);
            this.liveDetail = await this.client.live.detail(this.channelId);
            if (!this.liveDetail?.chatChannelId) throw new Error('Chat ID Missing');

            this.chat = this.client.chat({ channelId: this.channelId, chatChannelId: this.liveDetail.chatChannelId });
            
            this.chat.on('chat', (chat) => this.handleChat(chat));
            this.chat.on('donation', (donation) => this.handleDonation(donation));
            
            this.chat.on('connect', async () => {
                try {
                    const self = await this.chat?.selfProfile();
                    this.botUserIdHash = self?.userIdHash || null;
                    this.macros.setChatClient(this.chat!);
                    console.log(`[BotInstance] Logged in as: ${self?.nickname}`);
                } catch (e) {
                    console.error('[BotInstance] Auth Error: NID_AUTH/SES is invalid. Bot will remain in read-only mode.');
                    this.notify('error', '봇 로그인에 실패했습니다 (NID_AUTH/SES 만료). 채팅 전송이 제한됩니다.');
                }
            });

            await this.chat.connect();
        } catch (err) {
            console.error('[BotInstance] Setup Critical Error:', err);
        }
    }

    private async handleChat(chat: ChatEvent) {
        // [중요] 봇 본인의 채팅은 무시 (무한 루프 방지)
        if (this.botUserIdHash && chat.profile.userIdHash === this.botUserIdHash) return;

        // 대시보드 실시간 채팅창 전송
        this.onChatCallback(chat);

        // 기능 실행 (기록 및 통계는 chatEnabled와 상관없이 수행)
        await this.greet.handleChat(chat, this.chat!);
        this.points.awardPoints(chat, this.settings.getSettings());
        await this.votes.handleChat(chat);
        this.draw.handleChat(chat);

        // 명령어 및 응답 처리 (오직 chatEnabled가 켜져 있을 때만 실행)
        if (this.settings.getSettings().chatEnabled) {
            const msg = chat.message.trim();
            if (msg.startsWith('!')) {
                const cmd = msg.split(' ')[0];
                if (['!노래', '!신청', '!스킵'].includes(cmd)) await this.songs.handleCommand(chat, this.chat!, this.settings.getSettings());
                else if (cmd === '!시참') await this.participation.handleCommand(chat, this.chat!);
            }

            if (this.commands.hasCommand(msg)) await this.commands.executeCommand(chat, this.chat!);
            else if (this.counters.hasCounter(msg)) await this.counters.checkAndRespond(chat, this.chat!);
        }
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
        await DataManager.saveData(this.channelId, { settings: this.settings.getSettings(), commands: this.commands.getCommands(), counters: this.counters.getCounters(), macros: this.macros.getMacros(), points: this.points.getPointsData(), songQueue: this.songs.getData().songQueue, greetData: this.greet.getData(), votes: [this.votes.getState().currentVote], participants: this.participation.getState() });
    }

    public async disconnect() { if (this.chat) { this.macros.stopAllMacros(); await this.chat.disconnect(); this.chat = null; } }
    public getChannelId() { return this.channelId; }
    public getStatus() { return { connected: this.chat?.connected || false, channelId: this.channelId }; }
}