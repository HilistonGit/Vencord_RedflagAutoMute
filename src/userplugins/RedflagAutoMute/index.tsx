import definePlugin from "../../utils/types";
import { Devs } from "../../utils/constants";
import { findByProps } from "../../webpack";
import { React } from "../../webpack/common";
import { Settings } from "../../api/Settings";
import { Menu } from "../../webpack/common";
import "./styles.css";
import { OptionType } from "../../utils/types";
import { addContextMenuPatch } from "../../api/ContextMenu";
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, get, child, Database, onValue } from 'firebase/database';

const STORAGE_KEY = 'muteDatabaseURL';
let muteDatabase = {};
let db: Database | null = null;
let unsubscribeFromUpdates: (() => void) | null = null;

// Добавляем отслеживание состояния мута
let mutedUsers = new Set();

// Инициализация Firebase
function initializeFirebase() {
    try {
        const apiKey = Settings.plugins.RedflagAutoMute?.apiKey;
        const databaseUrl = Settings.plugins.RedflagAutoMute?.databaseUrl;

        if (!apiKey || !databaseUrl) {
            console.error('Firebase settings are not configured. Please set API Key and Database URL in plugin settings.');
            return;
        }

        const firebaseConfig = {
            apiKey,
            databaseURL: databaseUrl
        };
        
        const app = initializeApp(firebaseConfig);
        db = getDatabase(app);
        console.log('Firebase initialized successfully');
        setupRealtimeUpdates(); // Устанавливаем слушатель обновлений
    } catch (error) {
        console.error('Failed to initialize Firebase:', error);
    }
}

// Настройка обновлений в реальном времени
function setupRealtimeUpdates() {
    if (!db) {
        console.error('Firebase not initialized');
        return;
    }

    try {
        // Отписываемся от предыдущего слушателя, если он есть
        if (unsubscribeFromUpdates) {
            unsubscribeFromUpdates();
        }

        const dbRef = ref(db, 'users');
        
        // Устанавливаем слушатель обновлений
        unsubscribeFromUpdates = onValue(dbRef, (snapshot) => {
            const data = snapshot.val();
            if (data) {
                console.log('Received real-time update:', data);
                muteDatabase = data;
                
                // Сохраняем в локальное хранилище
                if (!Settings.plugins.RedflagAutoMute) {
                    Settings.plugins.RedflagAutoMute = { enabled: true };
                }
                Settings.plugins.RedflagAutoMute.localDatabase = JSON.stringify(muteDatabase);
                
                // Применяем изменения
                applyMuteList();
            }
        }, (error) => {
            console.error('Error in real-time updates:', error);
        });

        console.log('Real-time updates initialized');
    } catch (error) {
        console.error('Failed to setup real-time updates:', error);
    }
}

// Получаем необходимые модули Discord через webpack
const getModule = async (filter) => {
    try {
        return await findByProps(filter);
    } catch (e) {
        console.error(`Failed to find module with filter ${filter}:`, e);
        return null;
    }
};

// Получаем модули при старте
let mediaEngine = null;
let voiceModule = null;

async function initModules() {
    mediaEngine = await getModule("setLocalVolume");
    voiceModule = await findByProps('toggleSelfMute', 'toggleLocalMute');
    console.log('Voice module methods:', voiceModule ? Object.keys(voiceModule) : 'Not found');
}

function applyMuteList() {
    // Сначала собираем список тех, кто должен быть замьючен
    const shouldBeMutedUsers = new Set();
    
    Object.entries(muteDatabase).forEach(([id, type]) => {
        if (type === 'red' || (type === 'yellow' && Settings.plugins.RedflagAutoMute?.includeYellow)) {
            shouldBeMutedUsers.add(id);
        }
    });

    // Мутим тех, кто должен быть замьючен, но еще не замьючен
    for (const userId of shouldBeMutedUsers) {
        if (!mutedUsers.has(userId)) {
            muteUser(userId);
        }
    }

    // Размучиваем тех, кто замьючен, но не должен быть
    for (const userId of mutedUsers) {
        if (!shouldBeMutedUsers.has(userId)) {
            unmuteUser(userId);
        }
    }
}

async function muteUser(userId) {
    try {
        // Если пользователь уже замьючен, не делаем ничего
        if (mutedUsers.has(userId)) {
            console.log('User already muted:', userId);
            return;
        }

        if (!mediaEngine || !voiceModule) {
            await initModules();
        }
        
        if (mediaEngine && voiceModule) {
            console.log('Muting user:', userId);
            
            // Устанавливаем громкость на 0
            mediaEngine.setLocalVolume(userId, 0);
            
            // Пробуем разные методы мута
            if (voiceModule.setLocalMute) {
                voiceModule.setLocalMute(userId, true);
                console.log('Mute applied using setLocalMute');
            } else if (voiceModule.toggleLocalMute) {
                // Пробуем старый метод
                voiceModule.toggleLocalMute(userId);
                console.log('Mute applied using toggleLocalMute');
            } else {
                console.error('No mute function found');
                console.log('Available methods:', Object.keys(voiceModule));
            }

            // Добавляем пользователя в список замьюченных
            mutedUsers.add(userId);
        } else {
            console.error('Failed to get required modules for muting');
        }
    } catch (error) {
        console.error(`Failed to mute user ${userId}:`, error);
    }
}

async function unmuteUser(userId) {
    try {
        // Если пользователь не замьючен, не делаем ничего
        if (!mutedUsers.has(userId)) {
            console.log('User not muted:', userId);
            return;
        }

        if (!mediaEngine || !voiceModule) {
            await initModules();
        }
        
        if (mediaEngine && voiceModule) {
            console.log('Unmuting user:', userId);
            
            // Возвращаем громкость на 100
            mediaEngine.setLocalVolume(userId, 100);
            
            // Пробуем разные методы анмута
            if (voiceModule.setLocalMute) {
                voiceModule.setLocalMute(userId, false);
                console.log('Unmute applied using setLocalMute');
            } else if (voiceModule.toggleLocalMute) {
                // Пробуем старый метод
                voiceModule.toggleLocalMute(userId);
                console.log('Unmute applied using toggleLocalMute');
            } else {
                console.error('No unmute function found');
                console.log('Available methods:', Object.keys(voiceModule));
            }

            // Удаляем пользователя из списка замьюченных
            mutedUsers.delete(userId);
        } else {
            console.error('Failed to get required modules for unmuting');
        }
    } catch (error) {
        console.error(`Failed to unmute user ${userId}:`, error);
    }
}

function addUserToDatabase(userId, type) {
    muteDatabase[userId] = type;
    saveDatabase();
    muteUser(userId);
    console.log('Current database:', JSON.stringify(muteDatabase, null, 2));
}

// Модифицируем функцию saveDatabase для работы с real-time
async function saveDatabase() {
    try {
        if (!db) {
            console.error('Firebase not initialized');
            return;
        }

        // Сохраняем в Firebase только данные пользователей, без метки времени
        await set(ref(db, 'users'), muteDatabase);
        
        // Обновляем метку времени отдельно
        await set(ref(db, 'lastUpdate'), new Date().toISOString());
        
        console.log('Database saved to Firebase');
    } catch (error) {
        console.error('Failed to save database to Firebase:', error);
        // Сохраняем локально в случае ошибки
        if (!Settings.plugins.RedflagAutoMute) {
            Settings.plugins.RedflagAutoMute = { enabled: true };
        }
        Settings.plugins.RedflagAutoMute.localDatabase = JSON.stringify(muteDatabase);
        console.log('Database saved locally only');
    }
}

function getDatabaseStats() {
    const redCount = Object.values(muteDatabase).filter(type => type === 'red').length;
    const yellowCount = Object.values(muteDatabase).filter(type => type === 'yellow').length;
    return { total: Object.keys(muteDatabase).length, redCount, yellowCount };
}

// Добавляем стили для визуального оформления
const styles = {
    redCard: {
        border: '2px solid red',
        borderRadius: '4px'
    },
    yellowCard: {
        border: '2px solid yellow',
        borderRadius: '4px'
    }
};

// Компонент настроек
function SettingsPanel() {
    const [stats, setStats] = React.useState(() => getDatabaseStats());

    // Обновляем статистику при монтировании компонента
    React.useEffect(() => {
        setStats(getDatabaseStats());
        
        // Функция для обновления статистики
        const updateStats = () => {
            setStats(getDatabaseStats());
        };

        // Подписываемся на изменения в базе данных
        if (db) {
            const dbRef = ref(db, 'users');
            const unsubscribe = onValue(dbRef, (snapshot) => {
                updateStats();
            });

            // Отписываемся при размонтировании
            return () => {
                unsubscribe();
            };
        }
    }, []);
    
    return (
        <div className="redflag-settings">
            <div className="setting-item">
                <label>Database URL</label>
                <input
                    type="text"
                    value={Settings.plugins.RedflagAutoMute?.databaseUrl ?? ''}
                    onChange={e => {
                        if (!Settings.plugins.RedflagAutoMute) {
                            Settings.plugins.RedflagAutoMute = { enabled: true };
                        }
                        Settings.plugins.RedflagAutoMute.databaseUrl = e.target.value;
                        // Обновляем статистику при изменении URL
                        setStats(getDatabaseStats());
                    }}
                    placeholder="Enter your Firebase database URL"
                />
            </div>
            <div className="setting-item">
                <label>API Key</label>
                <input
                    type="password"
                    value={Settings.plugins.RedflagAutoMute?.apiKey ?? ''}
                    onChange={e => {
                        if (!Settings.plugins.RedflagAutoMute) {
                            Settings.plugins.RedflagAutoMute = { enabled: true };
                        }
                        Settings.plugins.RedflagAutoMute.apiKey = e.target.value;
                    }}
                    placeholder="Enter your Firebase API key"
                />
            </div>
            <div className="setting-item">
                <label>
                    <input
                        type="checkbox"
                        checked={Settings.plugins.RedflagAutoMute?.includeYellow ?? false}
                        onChange={e => {
                            if (!Settings.plugins.RedflagAutoMute) {
                                Settings.plugins.RedflagAutoMute = { enabled: true };
                            }
                            Settings.plugins.RedflagAutoMute.includeYellow = e.target.checked;
                        }}
                    />
                    Include Yellow Card Users
                </label>
            </div>
            <div className="stats">
                <div className="stats-title">Database Statistics</div>
                <div className="stats-item total">
                    <span className="stats-label">Total Users</span>
                    <span className="stats-value">{stats.total}</span>
                </div>
                <div className="stats-item red">
                    <span className="stats-label">Red Cards</span>
                    <span className="stats-value">{stats.redCount}</span>
                </div>
                <div className="stats-item yellow">
                    <span className="stats-label">Yellow Cards</span>
                    <span className="stats-value">{stats.yellowCount}</span>
                </div>
            </div>
        </div>
    );
}

export default definePlugin({
    name: "RedflagAutoMute",
    description: "Автоматический мьют пользователей на основе общей базы данных",
    authors: [{
        name: "RedflagAutoMute",
        id: 1234567890n
    }],
    defaultSettings: {
        enabled: true,
        databaseUrl: "https://testdb-5fa84-default-rtdb.firebaseio.com",
        apiKey: "AIzaSyAcGeSpTrnU7Z8juyr58tSPhDeQJZtCwwE",
        includeYellow: false,
        localDatabase: "{}"
    },
    
    patches: [
        {
            find: ".VoiceUser",
            replacement: {
                match: /function \w+\((\w+)\){/,
                replace: "function $1($2){const rf=arguments[0];if(rf?.user?.id&&muteDatabase[rf.user.id]){const style=muteDatabase[rf.user.id]==='red'?$styles.redCard:$styles.yellowCard;rf.style={...rf.style,...style};}"
            }
        }
    ],

    start() {
        // Очищаем список замьюченных при старте
        mutedUsers.clear();
        
        initModules().then(() => {
            console.log('Modules initialized');
            initializeFirebase();
        });
        
        this.contextMenuPatch = addContextMenuPatch("user-context", (children, { user }) => {
            if (!user?.id) return;

            // Получаем ID текущего пользователя
            const currentUser = findByProps('getCurrentUser')?.getCurrentUser?.();
            if (!currentUser) return;

            // Не показываем меню на текущем пользователе
            if (user.id === currentUser.id) return;

            const menuItems = [];

            // Если у пользователя уже есть карточка, показываем только кнопку Remove
            if (muteDatabase[user.id]) {
                menuItems.push(
                    React.createElement(Menu.MenuItem, {
                        id: "redflag-remove",
                        label: "Remove Card",
                        action: () => {
                            const userId = user.id;
                            unmuteUser(userId);
                            delete muteDatabase[userId];
                            saveDatabase();
                            return false;
                        }
                    })
                );
            } else {
                // Если карточки нет, показываем кнопки Red и Yellow
                menuItems.push(
                    React.createElement(Menu.MenuItem, {
                        id: "redflag-red-card",
                        label: "Red Card",
                        action: () => {
                            addUserToDatabase(user.id, "red");
                            return false;
                        }
                    }),
                    React.createElement(Menu.MenuItem, {
                        id: "redflag-yellow-card",
                        label: "Yellow Card",
                        action: () => {
                            addUserToDatabase(user.id, "yellow");
                            return false;
                        }
                    })
                );
            }

            // Добавляем меню только если есть пункты
            if (menuItems.length > 0) {
                children.push(
                    React.createElement(Menu.MenuGroup, null, [
                        React.createElement(Menu.MenuSeparator),
                        ...menuItems
                    ])
                );
            }
        });
    },

    stop() {
        if (this.contextMenuPatch) this.contextMenuPatch();
        if (unsubscribeFromUpdates) {
            unsubscribeFromUpdates();
            unsubscribeFromUpdates = null;
        }
        
        // Размучиваем всех при остановке плагина
        for (const userId of mutedUsers) {
            unmuteUser(userId);
        }
        mutedUsers.clear();
        muteDatabase = {};
        if (db) {
            db = null;
        }
    },

    options: {
        databaseUrl: {
            type: OptionType.STRING,
            description: "Firebase database URL",
            default: ""
        },
        apiKey: {
            type: OptionType.STRING,
            description: "Firebase API Key",
            default: ""
        },
        includeYellow: {
            type: OptionType.BOOLEAN,
            description: "Automatically mute users with yellow cards",
            default: false
        },
        localDatabase: {
            type: OptionType.STRING,
            description: "Local database storage",
            default: "{}"
        }
    },

    settingsPanel: SettingsPanel
}); 