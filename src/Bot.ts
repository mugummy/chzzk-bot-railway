// src/Bot.ts

import { ChzzkClient, ChzzkChat, ChatEvent, LiveDetail, Channel, DonationEvent } from 'chzzk';
import { config } from './config';
import { CommandManager } from './CommandManager';
import { CounterManager } from './CounterManager';
import { MacroManager } from './MacroManager';
import { DataManager, OverlaySettings, defaultOverlaySettings } from './DataManager';
import { ParticipationManager } from './ParticipationManager';
import { SongManager } from './SongManager';
import { PointManager } from './PointManager';
import { SettingsManager, BotSettings, defaultSettings } from './SettingsManager';
import { VoteManager } from './VoteManager';
import { DrawManager } from './DrawManager';
import { RouletteManager } from './RouletteManager';

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
    
    public settings: BotSettings = defaultSettings; // Initialize with defaults
    public overlaySettings: OverlaySettings = defaultOverlaySettings;
    private channelId: string = '';
    private onChatCallback: ((chat: ChatEvent) => void) | null = null;
    private onConnectCallback: (() => void) | null = null;
    private onStateChangeCallbacks: { [key: string]: StateListener } = {};
    public liveDetail: LiveDetail | null = null;
    public channel: Channel | null = null;
    private botUserIdHash: string | null = null;

    private hasConnected: boolean = false;

    constructor(private channelIdOrName: string) {
        this.client = new ChzzkClient({ nidAuth: config.nidAuth, nidSession: config.nidSes });
        this.channelId = channelIdOrName; // 초기값 설정 (나중에 connect에서 갱신됨)
    }

    public async init(): Promise<void> {
        // 채널 ID가 아직 확정되지 않았을 수 있으므로 connect 시점에 로드하거나,
        // 생성자에서 ID를 받는 경우 바로 로드합니다.
        // 여기서는 connect() 호출 전에는 기본값만 가집니다.
        console.log('[Bot] Initialized instance.');
    }

    // 실제 데이터 로드는 채널 ID가 확인된 후 connect()에서 수행
    private async loadChannelData(realChannelId: string) {
        console.log(`[Bot] 데이터 로딩 시작 (Channel: ${realChannelId})...`);
        const loadedData = await DataManager.loadData(realChannelId);

        this.settingsManager = new SettingsManager(loadedData.settings);
        this.settings = this.settingsManager.getSettings();
        this.overlaySettings = loadedData.overlaySettings || defaultOverlaySettings;

        this.commandManager = new CommandManager(this, loadedData.commands);
        this.counterManager = new CounterManager(this, loadedData.counters);
        this.macroManager = new MacroManager(this, loadedData.macros);
        this.participationManager = new ParticipationManager(this, loadedData.participants);
        this.songManager = new SongManager(this, loadedData);
        this.pointManager = new PointManager(loadedData.points);
        this.voteManager = new VoteManager(this, loadedData.votes);
        this.drawManager = new DrawManager(this, loadedData.drawHistory);
        this.rouletteManager = new RouletteManager(this, loadedData.rouletteHistory);

        this.participationManager.setOnStateChangeListener(() => this.notifyStateChange('participation'));
        this.songManager.setOnStateChangeListener(() => this.notifyStateChange('song'));
        this.voteManager.setOnStateChangeListener(() => this.notifyStateChange('vote'));
        this.drawManager.setOnStateChangeListener(() => this.notifyStateChange('draw'));
        this.rouletteManager.setOnStateChangeListener(() => this.notifyStateChange('roulette'));
        this.pointManager.setOnStateChangeListener(() => this.notifyStateChange('points'));
        console.log('[Bot] 데이터 로딩 완료.');
    }

    private notifyStateChange(type: string) { if (this.onStateChangeCallbacks[type]) { this.onStateChangeCallbacks[type](); } }
    public setOnStateChangeListener(type: string, listener: StateListener) { this.onStateChangeCallbacks[type] = listener; }
    
    public saveAllData(): void { 
        if (!this.channelId) return; // 채널 ID 없으면 저장 불가

        const participantState = this.participationManager?.getState();
        if (!participantState) return;

        DataManager.saveData(this.channelId, {
            ...this.songManager.getData(),
            commands: this.commandManager.getCommands(),
            counters: this.counterManager.getCounters(),
            macros: this.macroManager.getMacros(),
            points: this.pointManager.getPointsData(),
            settings: this.settings,
            votes: this.voteManager.getVotes(),
            participants: {
                queue: participantState.queue,
                participants: participantState.participants,
                maxParticipants: participantState.maxParticipants,
                isParticipationActive: participantState.isParticipationActive,
                userParticipationHistory: participantState.userParticipationHistory
            },
            drawHistory: this.drawManager.getDrawHistory(),
            rouletteHistory: this.rouletteManager.getRouletteHistory(),
            overlaySettings: this.overlaySettings
        }).catch(error => {
            console.error('[Bot] Error saving data:', error);
        }); 
    }
    
    public updateSettings(newSettings: Partial<BotSettings>) { 
        if(this.settingsManager) {
            this.settingsManager.updateSettings(newSettings); 
            this.settings = this.settingsManager.getSettings(); 
            this.saveAllData(); 
        }
    }
    
    public updateOverlaySettings(newSettings: Partial<OverlaySettings>) {
        this.overlaySettings = { ...this.overlaySettings, ...newSettings };
        this.saveAllData();
        this.notifyStateChange('overlay');
    }

    public getClient(): ChzzkClient { return this.client; }
    public getChannelId(): string { return this.channelId; }
    public isConnected(): boolean { return this.chat?.connected ?? false; }
    public setOnConnectListener(listener: () => void) { this.onConnectCallback = listener; }
    public setOnChatListener(listener: (chat: ChatEvent) => void) { this.onChatCallback = listener; }
    public sendChat(message: string) { 
        if (this.chat && this.isConnected()) { 
            try {
                this.chat.sendChat(message); 
            } catch (e) {
                console.log('[Bot] Failed to send chat (not logged in):', message);
            }
        } else {
            console.log('[Bot] Cannot send chat - not connected');
        }
    }

    public async connect(): Promise<void> {
        try {
            if (this.chat && this.isConnected()) {
                await this.disconnect();
            }

            console.log(`[Bot] 연결 시도: ${this.channelIdOrName}`);
            // 채널 ID 확정
            if (/^[a-f0-9]{32}$/.test(this.channelIdOrName)) {
                this.channelId = this.channelIdOrName;
            } else {
                console.log(`[Bot] 채널 이름으로 검색: ${this.channelIdOrName}`);
                const searchResult = await this.client.search.channels(this.channelIdOrName);
                const firstChannel = searchResult.channels[0];
                if (!firstChannel) {
                    throw new Error(`'${this.channelIdOrName}' 채널을 찾을 수 없습니다.`);
                }
                this.channelId = firstChannel.channelId;
            }
            console.log(`[Bot] Target Channel ID: ${this.channelId}`);

            // DB에서 데이터 로드 (채널 ID 확정 후)
            await this.loadChannelData(this.channelId);

            console.log(`[Bot] 채널 정보 가져오기...`);
            this.channel = await this.client.channel(this.channelId);
            console.log(`[Bot] 라이브 상세 정보 가져오기...`);
            this.liveDetail = await this.client.live.detail(this.channelId);

            if (!this.liveDetail?.chatChannelId) {
                throw new Error(`채팅 채널 정보를 가져올 수 없습니다. (라이브 상태 확인 필요)`);
            }
            console.log(`[Bot] 채팅 채널 ID: ${this.liveDetail.chatChannelId}`);

            this.chat = this.client.chat({ channelId: this.channelId, chatChannelId: this.liveDetail.chatChannelId });

            if(this.macroManager) this.macroManager.setChatClient(this.chat);
            this.setupListeners();
            console.log(`[Bot] 치지직 채팅 서버에 연결 중...`);
            await this.chat.connect();
            console.log(`[Bot] 봇이 성공적으로 연결되었습니다.`);
        } catch (error: any) {
            console.error(`[Bot] 연결 실패: ${error.message}`);
            if(this.macroManager) this.macroManager.stopAllMacros();
            throw error;
        }
    }

    private setupListeners(): void {
        if (!this.chat) return;

        this.chat.on('connect', async () => {
            if (this.hasConnected) return;
            this.hasConnected = true;

            console.log('[Bot] 채팅 서버에 성공적으로 연결되었습니다.');

            const currentChat = this.chat;
            if (currentChat) {
                try {
                    const selfProfile = await currentChat.selfProfile();
                    this.botUserIdHash = selfProfile.userIdHash;
                } catch (error) {
                    console.error('[Bot] 봇 자신의 userIdHash를 가져오는 데 실패했습니다:', error);
                }

                if (this.onConnectCallback) {
                    this.onConnectCallback();
                }
            }
        });

        this.chat.on('chat', async (chat: ChatEvent) => {
            if (this.onChatCallback) {
                this.onChatCallback(chat);
            }

            if (chat.profile.userIdHash === this.botUserIdHash) return;

            const msg = chat.message?.trim();
            if (!msg) return;

            this.pointManager?.awardPoints(chat, this.settings);
            this.drawManager?.handleChat(chat);

            if (msg[0] === '!') {
                const firstWord = msg.split(' ')[0];
                switch (firstWord) {
                    case '!시참':
                        if (this.chat && this.participationManager) {
                            await this.participationManager.handleCommand(chat, this.chat);
                        }
                        return;
                    case '!노래':
                    case '!노래신청':
                    case '!대기열':
                    case '!스킵':
                    case '!현재노래':
                    case '!다음곡':
                        this.songManager?.handleCommand(chat, this.chat!, this.settings);
                        return;
                    case '!포인트':
                        this.pointManager?.handleCommand(chat, this.chat!, this.settings);
                        return;
                    case '!투표':
                        this.voteManager?.handleCommand(chat, this.chat!);
                        return;
                    case '!신청곡':
                        this.chat?.sendChat('🎵 신청곡 명령어: !노래 [유튜브URL] (신청), !대기열 (목록), !현재노래 (현재곡), !스킵 (스킵/매니저전용)');
                        return;
                }
            }

            if (this.commandManager?.hasCommand(msg)) {
                this.commandManager.executeCommand(chat, this.chat!);
            } else if (this.counterManager?.hasCounter(msg)) {
                this.counterManager.checkAndRespond(chat, this.chat!);
            }
        });
        
        this.chat.on('donation', async (donation: DonationEvent) => {
            const youtubeUrlRegex = /(?:https?:\/\/)?[^\s]*youtu(?:be\.com\/watch\?v=|\.be\/)([a-zA-Z0-9_-]{11})(?:\S+)?/;
            const match = donation.message?.match(youtubeUrlRegex);
            if (match && match[0]) {
                try {
                    await this.songManager?.addSongFromDonation(donation, match[0], this.settings);
                    this.chat?.sendChat(`후원으로 노래가 신청되었습니다. 감사합니다!`);
                } catch(e: any) { this.chat?.sendChat(e.message); }
            }
        });

        this.chat.on('disconnect', () => this.macroManager?.stopAllMacros());
    }

    public async disconnect(): Promise<void> {
        if (this.chat) {
            this.macroManager?.stopAllMacros();
            await this.chat.disconnect();
            this.chat = null;
            this.hasConnected = false;
        }
    }

    public getChannelInfo() {
        if (!this.channel) return null;
        
        return {
            channelId: this.channelId,
            channelName: this.channel.channelName,
            channelImageUrl: this.channel.channelImageUrl,
            followerCount: this.channel.followerCount,
            openLive: this.channel.openLive,
            channelDescription: this.channel.channelDescription
        };
    }

    public getLiveStatus() {
        if (!this.liveDetail) return null;
        
        return {
            liveId: this.liveDetail.liveId,
            liveTitle: this.liveDetail.liveTitle,
            status: this.liveDetail.status,
            concurrentUserCount: this.liveDetail.concurrentUserCount,
            accumulateCount: this.liveDetail.accumulateCount,
            liveImageUrl: this.liveDetail.liveImageUrl
        };
    }
}