// The plugin's preload entry installs window.keygen itself on import.
// Apps that build their own preload can call installKeygenBridge() explicitly
// instead; apps with no preload of their own can point webPreferences.preload at
// keygenPreloadPath().
import "electron-plugin-keygen/preload";
