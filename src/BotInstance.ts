import { ChzzkClient, ChzzkChat, ChatEvent, DonationEvent } from 'chzzk';
import { CommandManager } from './CommandManager';
import { SongManager } from './SongManager';
import { VoteManager } from './VoteManager';
import { DataManager } from './DataManager';
import { PointManager } from './PointManager';
import { GreetManager } from './GreetManager';
import { SettingsManager } from './SettingsManager';

export class BotInstance {
    private client: ChzzkClient;
    public chat: ChzzkChat | null = null;
    
    // Services
    public commands: CommandManager;
    public songs: SongManager;
    public votes: VoteManager;
    public points: PointManager;
    public greet: GreetManager;
    public settings: SettingsManager;

    constructor(private channelId: string, nidAuth: string, nidSes: string) {
        this.client = new ChzzkClient({ nidAuth, nidSession: nidSes });
        // 매니저들은 초기화 후 loadData에서 데이터 주입됨
        this.commands = new CommandManager(this as any, []);
        this.songs = new SongManager(this as any, {} as any);
        this.votes = new VoteManager(this as any);
        this.points = new PointManager({});
        this.greet = new GreetManager(this as any);
        this.settings = new SettingsManager({} as any);
    }

    public async setup() {
        const data = await DataManager.loadData(this.channelId);
        
        // 데이터 주입 및 초기화
        this.settings = new SettingsManager(data.settings);
        this.commands = new CommandManager(this as any, data.commands);
        this.songs = new SongManager(this as any, data);
        this.points = new PointManager(data.points);
        this.greet = new GreetManager(this as any, data.greetData);
        if (data.votes?.[0]) this.votes.setCurrentVote(data.votes[0]);

        const live = await this.client.live.detail(this.channelId);
        if (!live?.chatChannelId) throw new Error('Chat ID Not Found');

        this.chat = this.client.chat({
            channelId: this.channelId,
            chatChannelId: live.chatChannelId
        });

        this.chat.on('chat', (chat) => this.handleChat(chat));
        this.chat.on('donation', (donation) => this.handleDonation(donation));
        
        await this.chat.connect();
        console.log(`[Bot] ${this.channelId} Connected`);
    }

    private async handleChat(chat: ChatEvent) {
        if (!this.settings.getSettings().chatEnabled) return;
        
        await this.greet.handleChat(chat, this.chat!);
        this.points.awardPoints(chat, this.settings.getSettings());
        await this.votes.handleChat(chat);
        
        const msg = chat.message.trim();
        if (this.commands.hasCommand(msg)) {
            await this.commands.executeCommand(chat, this.chat!);
        }
    }

    private async handleDonation(donation: DonationEvent) {
        await this.votes.handleDonation(donation);
        // 노래 신청 로직 등 추가
    }

    public getStatus() {
        return {
            connected: this.chat?.connected || false,
            channelId: this.channelId,
            settings: this.settings.getSettings()
        };
    }

    public async save() {
        await DataManager.saveData(this.channelId, {
            commands: this.commands.getCommands(),
            points: this.points.getPointsData(),
            settings: this.settings.getSettings(),
            votes: [this.votes.getState().currentVote],
            greetData: this.greet.getData(),
            songQueue: this.songs.getData().songQueue,
            participants: {}, // 참여 매니저 추가 필요
            currentSong: null,
            macros: []
        });
    }
}