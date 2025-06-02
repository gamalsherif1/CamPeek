// extension.js - Camera preview extension for GNOME Shell

import GObject from "gi://GObject";
import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";

import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const CamPeekIndicator = GObject.registerClass(
  class CamPeekIndicator extends PanelMenu.Button {
    _init(extension) {
      super._init(0.5, "CamPeek", false);

      this._extension = extension;
      this._isSelectionMenuOpen = false;
      this._cameraSelectionMenu = null;
      this._settings = extension.getSettings();

      // Get saved camera device or use default
      this._cameraDevice = this._settings.get_string("camera-device");
      if (!this._cameraDevice) {
        this._cameraDevice = "/dev/video0";
      }

      // Initialize variables for camera management
      this._cameraProcess = null;
      this._refreshTimeout = 0;
      this._startTimeout = 0;
      this._retryTimeout = null;
      this._tempDir = null;
      this._framesDir = null;
      this._lastProcessedFrame = -1;
      this._imageActor = null;
      this._imageWrapper = null;
      this._cameraInUseMessage = null;
      this._menuStyleTimeout = null;
      this._positionFixTimeouts = [];
      this._globalClickId = null;
      this._buttonPressHandler = null;
      this._outsideClickId = null;
      this._refreshListLabelTimeout = null;
      // Add for camera menu timeouts
      this._cameraMenuTimeoutId1 = null;
      this._cameraMenuTimeoutId2 = null;
    }

    _setupUI() {
      let topBox = new St.BoxLayout({
        style_class: "panel-status-menu-box campeek-box",
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      // Load icon
      let iconPath = this._extension.path + "/icons/mirror.png";
      let iconFile = Gio.File.new_for_path(iconPath);
      let gicon = null;

      try {
        if (iconFile.query_exists(null)) {
          gicon = new Gio.FileIcon({ file: iconFile });
        }
      } catch (e) {
        console.error(e, "CamPeek: Error loading custom icon");
      }

      this._icon = new St.Icon({
        gicon: gicon,
        icon_name: gicon ? null : "camera-web-symbolic",
        style_class: "system-status-icon campeek-icon",
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      topBox.add_child(this._icon);
      this.set_layout_manager(new Clutter.BinLayout());
      this.add_style_class_name("campeek-button");
      this.add_child(topBox);
    }

    _setupMenu() {
      this.menu.removeAll();

      // Save original menu open function to restore on cleanup
      this._originalOpenMenuFunc = this.menu.open;
      this.menu.open = (animate) => {
        this._originalOpenMenuFunc.call(this.menu, animate);
        this._scheduleMenuPositionFix();
      };

      // Create preview container
      let previewItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        style_class: "campeek-preview-item",
      });
      this.menu.addMenuItem(previewItem);

      this._previewContainer = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
        width: 480,
        height: 270,
        style_class: "campeek-preview-container",
        style: "clip-path: inset(0px round 12px);"
      });

      previewItem.add_child(this._previewContainer);

      // Add loading spinner
      this._spinner = new St.Icon({
        icon_name: "content-loading-symbolic",
        style_class: "spinner",
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._previewContainer.add_child(this._spinner);

      // Setup menu arrow
      if (this.menu._boxPointer) {
        this.menu._boxPointer._arrowSide = St.Side.TOP;
        this.menu._boxPointer.setSourceAlignment(0.5);
      }
    }

    _setupEventHandlers() {
      // Handle clicks outside menu area
      this.menu.actor.connect("button-press-event", (actor, event) => {
        if (event.get_source() !== actor) {
          this.menu.close();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      // Handle menu open/close events
      this.menu.connect("open-state-changed", (menu, isOpen) => {
        if (isOpen) {
          this._startCameraPreview();

          if (this._menuStyleTimeout) {
            GLib.source_remove(this._menuStyleTimeout);
            this._menuStyleTimeout = null;
          }

          this._menuStyleTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            10,
            () => {
              this._removeAllPadding();
              this._menuStyleTimeout = null;
              return GLib.SOURCE_REMOVE;
            },
          );

          this._globalClickId = global.stage.connect(
            "button-press-event",
            (actor, event) => {
              if (this.menu.isOpen) {
                this.menu.close();
              }
            },
          );
        } else {
          this._stopCameraPreview();
          this._clearPositionFixTimeouts();

          if (this._globalClickId) {
            global.stage.disconnect(this._globalClickId);
            this._globalClickId = null;
          }
        }
      });

      // Handle right-click for camera selection
      this._buttonPressHandler = (actor, event) => {
        if (event.get_button() === 3) {
          // Right click - show camera selection menu and prevent preview menu from opening
          this._showCameraSelectionMenu();
          return Clutter.EVENT_STOP;
        } else if (event.get_button() === 1) {
          // Left click - handle normal menu behavior
          if (this._cameraSelectionMenu && this._isSelectionMenuOpen) {
            this._cameraSelectionMenu.close();
            this._cameraSelectionMenu = null;
            this._isSelectionMenuOpen = false;
          }
          // Let the default menu open behavior continue
          return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_PROPAGATE;
      };
      this.connect("button-press-event", this._buttonPressHandler);
    }

    _showCameraSelectionMenu() {
      // First, ensure the preview menu is closed
      if (this.menu.isOpen) {
        this.menu.close();
      }
      
      // Prevent multiple menus from showing
      if (this._isSelectionMenuOpen || this._cameraSelectionMenu) {
        // If already open, just bring focus to it
        if (this._cameraSelectionMenu) {
          this._cameraSelectionMenu.close();
          this._cameraSelectionMenu = null;
        }
        this._isSelectionMenuOpen = false;
        return;
      }
      
      // Set flag that menu is open
      this._isSelectionMenuOpen = true;
      
      // Create a new menu for camera selection
      let cameraMenu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
      this._cameraSelectionMenu = cameraMenu;

      // Add a loading item (only, no current camera placeholder)
      this._loadingMenuItem = new PopupMenu.PopupMenuItem(_("Loading cameras..."));
      this._loadingMenuItem.setSensitive(false);
      cameraMenu.addMenuItem(this._loadingMenuItem);

      // Record the loading start time
      this._cameraLoadingStartTime = Date.now();

      // We need to manually position and show it
      Main.uiGroup.add_child(cameraMenu.actor);

      // Make the menu modal so clicking outside closes it
      cameraMenu.actor.connect("button-press-event", (actor, event) => {
        // Close the menu if clicked outside
        if (event.get_source() !== actor) {
          cameraMenu.close();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      cameraMenu.open();

      // Connect to global button press to close when clicking outside
      this._outsideClickId = global.stage.connect(
        "button-press-event",
        (actor, event) => {
          if (cameraMenu.isOpen) {
            cameraMenu.close();
          }
        },
      );

      // Close the menu when a selection is made or clicked outside
      cameraMenu.connect("open-state-changed", (menu, isOpen) => {
        if (!isOpen) {
          // Reset the flag when menu closes
          this._isSelectionMenuOpen = false;
          // Clear the reference to the menu
          this._cameraSelectionMenu = null;
          this._loadingMenuItem = null;
          // Disconnect the global click handler when menu closes
          if (this._outsideClickId) {
            global.stage.disconnect(this._outsideClickId);
            this._outsideClickId = null;
          }
          Main.uiGroup.remove_child(menu.actor);
          menu.destroy();
        }
      });

      // Trigger async detection to update the menu
      this._detectCamerasAsync();
    }

    _populateCameraMenu(menu) {
      // This function is no longer needed as we're using _rebuildCameraMenu
      // Keep it as a no-op for compatibility
      console.log("CamPeek: _populateCameraMenu is deprecated, using _rebuildCameraMenu instead");
    }

    _findAvailableCameras() {
      // No longer return a placeholder, just return an empty array
      return [];
    }
    
    _detectCamerasAsync() {
      // Cancel any existing detection
      if (this._cameraDetectionProcess) {
        try {
          this._cameraDetectionProcess.force_exit();
        } catch (e) {
          console.error("CamPeek: Error cancelling previous detection:", e);
        }
        this._cameraDetectionProcess = null;
      }
      
      try {
        // Record the loading start time
        this._cameraLoadingStartTime = Date.now();
        
        // Use optimized detection methods with broader device range
        let commands = [
          // Primary method: list video devices (expanded range)
          'ls -1 /dev/video* 2>/dev/null | head -20',
          // Alternative method: use v4l2-ctl if available (expanded range)
          'v4l2-ctl --list-devices 2>/dev/null | grep -E "^/dev/video" | head -20',
          // Fallback: check common camera device paths (expanded range)
          'for i in {0..19}; do [ -e "/dev/video$i" ] && echo "/dev/video$i"; done'
        ];
        
        this._tryAsyncDetectionMethod(commands, 0);
      } catch (e) {
        console.error("CamPeek: Error starting async camera detection:", e);
        // If we have an open camera selection menu, update it with no cameras
        if (this._cameraSelectionMenu && this._isSelectionMenuOpen) {
          this._updateCameraSelectionMenu("");
        }
      }
    }
    
    _tryAsyncDetectionMethod(commands, index) {
      if (index >= commands.length) {
        // All methods failed, check for fallback devices
        this._asyncFallbackDetection();
        return;
      }
      
      const command = commands[index];
      console.log("CamPeek: Trying detection method " + (index + 1) + ": " + command);
      
      this._runCommand(command, (success, stdout, stderr) => {
        if (success && stdout && stdout.trim() !== "") {
          let devices = stdout.split("\n").filter(d => d && d.trim() !== "" && d.startsWith("/dev/video"));
          
          if (devices.length > 0) {
            console.log("CamPeek: Found " + devices.length + " potential camera device(s) using method " + (index + 1));
            this._testAllCameras(devices);
            return;
          }
        }
        
        // This method didn't work, try the next one
        this._tryAsyncDetectionMethod(commands, index + 1);
      }, {
        timeout: 3000,
        description: "detection method " + (index + 1)
      });
    }
    
    _asyncFallbackDetection() {
      console.log("CamPeek: Async detection - checking fallback devices...");
      
      // Check expanded range of camera device paths for better compatibility
      let commonPaths = [
        '/dev/video0', '/dev/video1', '/dev/video2', '/dev/video3', '/dev/video4',
        '/dev/video5', '/dev/video6', '/dev/video7', '/dev/video8', '/dev/video9',
        '/dev/video10', '/dev/video11', '/dev/video12', '/dev/video13', '/dev/video14',
        '/dev/video15', '/dev/video16', '/dev/video17', '/dev/video18', '/dev/video19'
      ];
      let foundDevices = [];
      
      for (let path of commonPaths) {
        let deviceFile = Gio.File.new_for_path(path);
        if (deviceFile.query_exists(null)) {
          foundDevices.push(path);
        }
      }
      
      if (foundDevices.length > 0) {
        console.log("CamPeek: Found " + foundDevices.length + " device(s) in async fallback check");
        let deviceOutput = foundDevices.join("\n");
        this._testAllCameras(foundDevices);
      } else {
        console.log("CamPeek: No camera devices found in async detection");
        // If we have an open camera selection menu, update it with no cameras
        if (this._cameraSelectionMenu && this._isSelectionMenuOpen) {
          this._updateCameraSelectionMenu("");
        }
      }
    }

    _testAndFilterCameras(deviceOutput) {
      // Don't process if menu is closed
      if (!this._cameraSelectionMenu || !this._isSelectionMenuOpen) {
        return;
      }

      // If no devices found, update with empty list
      if (!deviceOutput || deviceOutput === "none") {
        this._updateCameraSelectionMenu("");
        return;
      }

      // Parse the device list
      const deviceList = deviceOutput.split("\n").filter(d => d && d.trim() !== "");
      if (deviceList.length === 0) {
        this._updateCameraSelectionMenu("");
        return;
      }

      // Show a testing message in the menu
      if (this._cameraSelectionMenu) {
        this._cameraSelectionMenu.removeAll();
        let testingItem = new PopupMenu.PopupMenuItem(_("Testing cameras..."));
        testingItem.setSensitive(false);
        this._cameraSelectionMenu.addMenuItem(testingItem);
      }

      // Set up variables for tracking tested devices
      this._testedDevices = [];
      this._workingDevices = "";
      this._pendingDevices = deviceList.length;
      
      // Test each device one by one
      deviceList.forEach((device) => {
        this._testCameraQuick(device.trim(), (works) => {
          this._testedDevices.push(device.trim());
          this._pendingDevices--;
          
          if (works) {
            this._workingDevices += device.trim() + "\n";
          }
          
          // When all devices are tested, update the menu
          if (this._pendingDevices <= 0) {
            console.log("CamPeek: All devices tested, working devices:", this._workingDevices);
            this._updateCameraSelectionMenu(this._workingDevices);
            
            // Clean up
            delete this._testedDevices;
            delete this._workingDevices;
            delete this._pendingDevices;
          }
        });
      });
    }

    _testCameraQuick(device, callback) {
      try {
        // Optimize testing order: fastest to slowest
        // 1. First check if device supports video capture (fastest)
        this._testCameraCapabilities(device, (capabilitySuccess) => {
          if (!capabilitySuccess) {
            // If device doesn't support video capture, no need to test further
            callback(false);
            return;
          }
          
          // 2. Check for video formats (fast)
          this._testCameraWithV4L2(device, (v4l2Success) => {
            if (!v4l2Success) {
              // If no formats available, no need to test with GStreamer
              callback(false);
              return;
            }
            
            // 3. Finally test with GStreamer (slowest but most reliable)
            this._testCameraWithGStreamer(device, callback);
          });
        });
      } catch (e) {
        console.error("CamPeek: Error starting camera test for " + device + ":", e);
        callback(false);
      }
    }
    
    _testCameraWithGStreamer(device, callback) {
      const command = "timeout 2s gst-launch-1.0 v4l2src device=" + device + " num-buffers=1 ! videoconvert ! videoscale ! video/x-raw,width=320,height=240 ! fakesink > /dev/null 2>&1 && echo success || echo fail";
      
      this._runCommand(command, (success, stdout, stderr) => {
        const works = success && stdout && stdout.trim() === "success";
        callback(works);
      }, {
        timeout: 3000,
        description: "GStreamer test for " + device
      });
    }
    
    _testCameraWithV4L2(device, callback) {
      const command = "v4l2-ctl --device=" + device + " --list-formats 2>/dev/null | grep -E \"\\[[0-9]+\\]:\" | wc -l";
      
      this._runCommand(command, (success, stdout, stderr) => {
        if (success && stdout) {
          let formatCount = parseInt(stdout.trim());
          let works = !isNaN(formatCount) && formatCount > 0;
          callback(works);
        } else {
          callback(false);
        }
      }, {
        timeout: 2000,
        description: "v4l2-ctl test for " + device
      });
    }
    
    _testCameraBasicAccess(device, callback) {
      try {
        // Basic test: check if device exists and is readable
        let deviceFile = Gio.File.new_for_path(device);
        if (!deviceFile.query_exists(null)) {
          callback(false);
          return;
        }
        
        // Check if device is a video capture device using capabilities
        this._testCameraCapabilities(device, callback);
      } catch (e) {
        console.error("CamPeek: Error in basic access test for " + device + ":", e);
        callback(false);
      }
    }
    
    _testCameraCapabilities(device, callback) {
      // Check if device supports video capture using Device Caps (most reliable for modern cameras)
      const command = "v4l2-ctl --device=" + device + " --info 2>/dev/null | sed -n '/Device Caps/,/^$/p' | grep -q \"Video Capture\" && echo device_caps_ok || echo device_caps_fail";
      
      this._runCommand(command, (success, stdout, stderr) => {
        if (stdout && stdout.trim() === "device_caps_ok") {
          callback(true);
          return;
        }
        
        // Fallback method for older cameras
        this._testCameraCapabilitiesFallback(device, callback);
      }, {
        timeout: 2000,
        description: "capabilities test for " + device
      });
    }
    
    _testCameraCapabilitiesFallback(device, callback) {
      // Fallback method: check if device is a character device and readable
      const command = "[ -c \"" + device + "\" ] && [ -r \"" + device + "\" ] && echo success || echo fail";
      
      this._runCommand(command, (success, stdout, stderr) => {
        const works = stdout && stdout.trim() === "success";
        callback(works);
      }, {
        timeout: 1000,
        description: "fallback capabilities test for " + device
      });
    }

    _updateCameraSelectionMenu(deviceOutput) {
      // Don't update if menu is closed
      if (!this._cameraSelectionMenu || !this._isSelectionMenuOpen) {
        return;
      }
      try {
        let cameras = [];
        if (deviceOutput && deviceOutput !== "none") {
          let deviceList = deviceOutput.split("\n").filter(d => d && d.trim() !== "");
          
          // Get camera names asynchronously for better UX
          this._getCameraNames(deviceList, (cameraInfo) => {
            cameras = cameraInfo;
            this._finalizeCameraMenu(cameras);
          });
          return;
        }
        
        // If no cameras found, show a disabled item
        this._finalizeCameraMenu([]);
      } catch (e) {
        console.error("CamPeek: Error updating camera menu:", e);
      }
    }
    
    _getCameraNames(deviceList, callback) {
      let cameras = [];
      let pendingRequests = deviceList.length;
      
      if (pendingRequests === 0) {
        callback([]);
        return;
      }
      
      deviceList.forEach((device, index) => {
        let devicePath = device.trim();
        
        // Try to get the actual camera name
        const command = "v4l2-ctl --device=" + devicePath + " --info 2>/dev/null | grep \"Card type\" | cut -d: -f2 | sed 's/^[[:space:]]*//' || echo \"Camera " + index + "\"";
        
        this._runCommand(command, (success, stdout, stderr) => {
          let cameraName = stdout ? stdout.trim() : "Camera " + index;
          
          // Fallback to generic name if empty or too long
          if (!cameraName || cameraName === "" || cameraName.length > 50) {
            cameraName = "Camera " + index;
          }
          
          cameras.push({
            device: devicePath,
            label: cameraName + " (" + devicePath + ")",
            name: cameraName
          });
          
          pendingRequests--;
          if (pendingRequests <= 0) {
            // Sort cameras by device path for consistent ordering
            cameras.sort((a, b) => a.device.localeCompare(b.device));
            callback(cameras);
          }
        }, {
          timeout: 2000,
          description: "camera name detection for " + devicePath
        });
      });
    }
    
    _finalizeCameraMenu(cameras) {
      // If no cameras found, show a disabled item
      if (cameras.length === 0) {
        // Remove all items and show only 'No cameras found'
        const finish = () => {
          this._cameraSelectionMenu.removeAll();
          let noCamerasItem = new PopupMenu.PopupMenuItem(_("No cameras found"));
          noCamerasItem.setSensitive(false);
          this._cameraSelectionMenu.addMenuItem(noCamerasItem);
          // Add refresh and donate as usual
          this._rebuildCameraMenu([]); // Will add refresh/donate
        };
        // Ensure minimum loading time
        let elapsed = Date.now() - (this._cameraLoadingStartTime || 0);
        let minDuration = 100;
        if (elapsed < minDuration) {
          // Store timeout ID for cleanup
          if (this._cameraMenuTimeoutId1) {
            GLib.source_remove(this._cameraMenuTimeoutId1);
            this._cameraMenuTimeoutId1 = null;
          }
          this._cameraMenuTimeoutId1 = GLib.timeout_add(GLib.PRIORITY_DEFAULT, minDuration - elapsed, () => { finish(); this._cameraMenuTimeoutId1 = null; return GLib.SOURCE_REMOVE; });
        } else {
          finish();
        }
        return;
      }
      // Otherwise, rebuild menu with real cameras
      const finish = () => { this._rebuildCameraMenu(cameras); };
      let elapsed = Date.now() - (this._cameraLoadingStartTime || 0);
      let minDuration = 400;
      if (elapsed < minDuration) {
        // Store timeout ID for cleanup
        if (this._cameraMenuTimeoutId2) {
          GLib.source_remove(this._cameraMenuTimeoutId2);
          this._cameraMenuTimeoutId2 = null;
        }
        this._cameraMenuTimeoutId2 = GLib.timeout_add(GLib.PRIORITY_DEFAULT, minDuration - elapsed, () => { finish(); this._cameraMenuTimeoutId2 = null; return GLib.SOURCE_REMOVE; });
      } else {
        finish();
      }
    }

    _rebuildCameraMenu(cameras) {
      // Don't update if menu is closed
      if (!this._cameraSelectionMenu || !this._isSelectionMenuOpen) {
        return;
      }
      try {
        // Remove all items first
        this._cameraSelectionMenu.removeAll();
        // Add a title item
        let titleItem = new PopupMenu.PopupMenuItem(_("Select Camera Device"));
        titleItem.setSensitive(false);
        this._cameraSelectionMenu.addMenuItem(titleItem);
        this._cameraSelectionMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // Add each camera to the menu
        let activeCamera = this._cameraDevice;
        cameras.forEach((camera) => {
          let isActive = camera.device === activeCamera;
          let item = new PopupMenu.PopupMenuItem(camera.label);
          if (isActive) {
            item.setOrnament(PopupMenu.Ornament.DOT);
          }
          item.connect("activate", () => {
            this._selectCamera(camera.device);
          });
          this._cameraSelectionMenu.addMenuItem(item);
        });
        // Add a refresh option at the bottom
        this._cameraSelectionMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let refreshItem = new PopupMenu.PopupMenuItem(_("Refresh Camera List"));
        refreshItem.connect("activate", () => {
          refreshItem.label.text = _("Refreshing...");
          // Remove all and show loading
          this._cameraSelectionMenu.removeAll();
          let loadingItem = new PopupMenu.PopupMenuItem(_("Loading cameras..."));
          loadingItem.setSensitive(false);
          this._cameraSelectionMenu.addMenuItem(loadingItem);
          // Record the loading start time for refresh
          this._cameraLoadingStartTime = Date.now();
          this._detectCamerasAsync();
        });
        this._cameraSelectionMenu.addMenuItem(refreshItem);
        // Add donation button in a separate section
        this._cameraSelectionMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let donateItem = new PopupMenu.PopupMenuItem(_("Support ❤️"));
        donateItem.label.style = "color: #ff0000;";
        donateItem.connect("activate", () => {
          let url = "https://buymeacoffee.com/gamalsherii";
          try {
            Gio.AppInfo.launch_default_for_uri_async(url, null, null, (source, result) => {
              try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
              } catch (e) {
                console.error("Failed to open URL: " + e.message);
              }
            });
          } catch (e) {
            console.error("Error opening donation URL:", e);
          }
        });
        this._cameraSelectionMenu.addMenuItem(donateItem);
      } catch (e) {
        console.error("CamPeek: Error rebuilding camera menu:", e);
      }
    }

    _selectCamera(device) {
      // Update the camera device
      this._cameraDevice = device;

      // Save the selection to settings
      this._settings.set_string("camera-device", device);

      // If camera is currently active, restart it
      if (this.menu.isOpen) {
        this._stopCameraPreview();
        this._startCameraPreview();
      }
    }

    _scheduleMenuPositionFix() {
      // Clear any existing timeouts
      this._clearPositionFixTimeouts();

      // Schedule a single position fix with a small delay
      let id = GLib.timeout_add(GLib.PRIORITY_HIGH, 100, () => {
        this._fixMenuPosition();
        this._positionFixTimeouts = this._positionFixTimeouts.filter(
          (t) => t !== id
        );
        return GLib.SOURCE_REMOVE;
      });

      this._positionFixTimeouts.push(id);
    }

    _clearPositionFixTimeouts() {
      // Clean up any position fix timeouts
      this._positionFixTimeouts.forEach((id) => {
        if (id) {
          GLib.source_remove(id);
        }
      });
      this._positionFixTimeouts = [];
    }

    _fixMenuPosition() {
      try {
        // Only try to fix position if menu is open
        if (!this.menu.isOpen) {
          return;
        }

        // Get button position and size
        let [buttonX, buttonY] = this.get_transformed_position();
        let buttonWidth = this.get_width();
        let buttonHeight = this.get_height();

        // Get the menu actor
        let menuActor = this.menu.actor || this.menu;
        if (!menuActor) return;

        // Get menu size
        let menuWidth = menuActor.get_width();
        let menuHeight = menuActor.get_height();

        // Calculate center position for the menu
        let targetX = Math.round(buttonX + buttonWidth / 2 - menuWidth / 2);

        // Set menu position
        menuActor.set_position(targetX, menuActor.get_y());

        // Avoid trying to set arrow position directly as it's causing errors
        // Just log a message instead
        console.log("CamPeek: Menu position updated");
      } catch (e) {
        console.error("CamPeek: Error fixing menu position:", e);
      }
    }

    _startCameraPreview() {
      if (this._cameraProcess) {
        return; // Camera already running
      }

      this._spinner.visible = true;

      // Remove any existing camera-in-use message
      if (this._cameraInUseMessage && this._cameraInUseMessage.get_parent()) {
        this._previewContainer.remove_child(this._cameraInUseMessage);
        this._cameraInUseMessage = null;
      }

      // Ensure the preview container has rounded corners
      this._previewContainer.style = "clip-path: inset(0px round 12px);";
      
      // Skip all camera checks and directly try to start the camera
      this._actuallyStartCamera();
    }

    _actuallyStartCamera() {
      try {
        // First check if the camera device exists
        let deviceFile = Gio.File.new_for_path(this._cameraDevice);
        if (!deviceFile.query_exists(null)) {
          this._spinner.visible = false;
          this._showCameraErrorMessage(
            "No Camera Found", 
            "Connect a camera device",
            "Make sure your camera is connected and try again. You can also right-click the CamPeek icon to select a different camera."
          );
          return;
        }

        // Create a temporary directory for our frames
        let tempDir = GLib.build_filenamev([
          GLib.get_tmp_dir(),
          "campeek-frames-" + GLib.random_int(),
        ]);
        this._tempDir = tempDir;

        // Ensure the directory exists
        GLib.mkdir_with_parents(tempDir, 0o755);

        // Create a proper container for the camera output using Widget with BinLayout
        if (!this._cameraOutput) {
          this._cameraOutput = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            width: 480,
            height: 270,
            style_class: "campeek-frame",
            style: "clip-path: inset(0px round 12px);"
          });
          this._previewContainer.add_child(this._cameraOutput);
        }

        // We'll use a sequence of numbered files
        this._frameIndex = 0;
        this._framesDir = GLib.build_filenamev([tempDir, "frames"]);
        GLib.mkdir_with_parents(this._framesDir, 0o755);

        // Create a script that uses GStreamer for more efficient frame capture with adaptive resolution
        let scriptPath = GLib.build_filenamev([tempDir, "capture.sh"]);
        let scriptContent = "#!/usr/bin/env bash\n\n" +
          "# Store the process ID\n" +
          "echo $$ > \"" + tempDir + "/pid\"\n\n" +
          "# Clean up any existing frames\n" +
          "rm -f " + this._framesDir + "/frame_*.jpg 2>/dev/null\n\n" +
          "# Check if GStreamer is available\n" +
          "if ! command -v gst-launch-1.0 &> /dev/null; then\n" +
          "    echo \"GSTREAMER_MISSING\" > \"" + tempDir + "/camera_error\"\n" +
          "    exit 1\n" +
          "fi\n\n" +
          "# Check if device exists and is accessible\n" +
          "if [ ! -e \"" + this._cameraDevice + "\" ]; then\n" +
          "    echo \"DEVICE_NOT_FOUND\" > \"" + tempDir + "/camera_error\"\n" +
          "    exit 1\n" +
          "fi\n\n" +
          "if [ ! -r \"" + this._cameraDevice + "\" ]; then\n" +
          "    echo \"PERMISSION_DENIED\" > \"" + tempDir + "/camera_error\"\n" +
          "    exit 1\n" +
          "fi\n\n" +
          "# Get camera capabilities and choose best format\n" +
          "CAMERA_CAPS=\"\"\n" +
          "if command -v v4l2-ctl &> /dev/null; then\n" +
          "    # Try to get supported resolutions and formats\n" +
          "    FORMATS=$(v4l2-ctl --device=" + this._cameraDevice + " --list-formats-ext 2>/dev/null | grep -E \"Size:|Interval:\" | head -20)\n" +
          "    \n" +
          "    # Check for common resolutions (prefer 16:9 aspect ratio)\n" +
          "    if echo \"$FORMATS\" | grep -q \"640x360\"; then\n" +
          "        CAMERA_CAPS=\"video/x-raw,width=640,height=360\"\n" +
          "    elif echo \"$FORMATS\" | grep -q \"854x480\"; then\n" +
          "        CAMERA_CAPS=\"video/x-raw,width=854,height=480\"\n" +
          "    elif echo \"$FORMATS\" | grep -q \"960x540\"; then\n" +
          "        CAMERA_CAPS=\"video/x-raw,width=960,height=540\"\n" +
          "    elif echo \"$FORMATS\" | grep -q \"1280x720\"; then\n" +
          "        CAMERA_CAPS=\"video/x-raw,width=1280,height=720\"\n" +
          "    elif echo \"$FORMATS\" | grep -q \"640x480\"; then\n" +
          "        CAMERA_CAPS=\"video/x-raw,width=640,height=480\"\n" +
          "    elif echo \"$FORMATS\" | grep -q \"320x240\"; then\n" +
          "        CAMERA_CAPS=\"video/x-raw,width=320,height=240\"\n" +
          "    fi\n" +
          "fi\n\n" +
          "# Fallback to auto-negotiation if no specific format found\n" +
          "if [ -z \"$CAMERA_CAPS\" ]; then\n" +
          "    CAMERA_CAPS=\"video/x-raw\"\n" +
          "fi\n\n" +
          "# Use GStreamer for frame capture with adaptive resolution and better error handling\n" +
          "gst-launch-1.0 v4l2src device=" + this._cameraDevice + " ! \\\n" +
          "videoconvert ! videoscale add-borders=false ! $CAMERA_CAPS,framerate=30/1 ! \\\n" +
          "videoscale ! video/x-raw,width=480,height=270 ! \\\n" +
          "queue max-size-buffers=2 leaky=downstream ! \\\n" +
          "videoflip method=horizontal-flip ! jpegenc quality=85 ! \\\n" +
          "multifilesink location=\"" + this._framesDir + "/frame_%05d.jpg\" max-files=5 post-messages=true 2>/dev/null || \\\n" +
          "(echo \"CAMERA_ERROR\" > \"" + tempDir + "/camera_error\" && exit 1)\n";

        // Write the script to a file
        let bytes = new TextEncoder().encode(scriptContent);
        let scriptFile = Gio.File.new_for_path(scriptPath);

        let outputStream = scriptFile.replace(
          null,
          false,
          Gio.FileCreateFlags.NONE,
          null,
        );

        outputStream.write_bytes(new GLib.Bytes(bytes), null);
        outputStream.close(null);

        // Set executable permission
        let info = scriptFile.query_info(
          "unix::mode",
          Gio.FileQueryInfoFlags.NONE,
          null,
        );
        let mode = info.get_attribute_uint32("unix::mode");
        info.set_attribute_uint32("unix::mode", mode | 0o100); // Add executable bit
        scriptFile.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);

        // Launch the script to start capturing frames
        this._cameraProcess = Gio.Subprocess.new(
          ["bash", scriptPath],
          Gio.SubprocessFlags.NONE,
        );

        // Reset frame counter
        this._lastProcessedFrame = -1;

        // Clear existing refresh timeout if it exists
        if (this._refreshTimeout) {
          GLib.source_remove(this._refreshTimeout);
          this._refreshTimeout = 0;
        }

        // Start a refresh timer with higher priority for better performance
        this._refreshTimeout = GLib.timeout_add(
          GLib.PRIORITY_HIGH,
          1000 / 30, // Target 30fps refresh
          () => {
            this._refreshFrame();
            return GLib.SOURCE_CONTINUE;
          },
        );

        // Clear existing start timeout if it exists
        if (this._startTimeout) {
          GLib.source_remove(this._startTimeout);
          this._startTimeout = 0;
        }

        // Set a timeout to check if camera started successfully - increased timeout
        this._startTimeout = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          4000, // Increased from 2000 to 4000 ms for slower systems
          () => {
            if (this._spinner.visible) {
              this._spinner.visible = false;
              
              // Check for specific error messages
              this._checkCameraError();
            }
            this._startTimeout = 0;
            return GLib.SOURCE_REMOVE;
          },
        );
      } catch (e) {
        console.error("CamPeek: Error starting camera", e);
        this._spinner.visible = false;
        this._showCameraErrorMessage("Error starting camera", "Try again", e.message);
      }
    }
    
    _checkCameraError() {
      if (!this._tempDir) {
        this._showCameraErrorMessage(
          "Camera couldn't be started", 
          "Try again",
          "The camera might be in use by another application."
        );
        return;
      }
      
      let errorFile = GLib.build_filenamev([this._tempDir, "camera_error"]);
      let errorFileObj = Gio.File.new_for_path(errorFile);
      
      if (errorFileObj.query_exists(null)) {
        try {
          let [success, contents] = errorFileObj.load_contents(null);
          if (success) {
            let errorType = new TextDecoder().decode(contents).trim();
            
            switch (errorType) {
              case "GSTREAMER_MISSING":
                this._showCameraErrorMessage(
                  "GStreamer Not Found",
                  "Install GStreamer",
                  "Please install GStreamer: sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good"
                );
                break;
              case "DEVICE_NOT_FOUND":
                this._showCameraErrorMessage(
                  "No Camera Found",
                  "Connect a camera device",
                  "Make sure your camera is connected and recognized by the system."
                );
                break;
              case "PERMISSION_DENIED":
                this._showCameraErrorMessage(
                  "Permission Denied",
                  "Check permissions",
                  "Add your user to the video group: sudo usermod -a -G video $USER (then log out and back in)"
                );
                break;
              case "CAMERA_ERROR":
              default:
                this._showCameraErrorMessage(
                  "Camera Error",
                  "Try again",
                  "The camera might be in use by another application or not working properly."
                );
                break;
            }
          }
        } catch (e) {
          console.error("Error reading camera error file:", e);
          this._showCameraErrorMessage(
            "Camera couldn't be started",
            "Try again", 
            "The camera might be in use by another application."
          );
        }
      } else {
        this._showCameraErrorMessage(
          "Camera couldn't be started",
          "Try again",
          "The camera might be in use by another application."
        );
      }
    }

    _refreshFrame() {
      try {
        // Check for early error detection
        if (this._tempDir) {
          let errorFile = Gio.File.new_for_path(
            GLib.build_filenamev([this._tempDir, "camera_error"]),
          );
          if (errorFile.query_exists(null)) {
            if (this._spinner.visible) {
              this._spinner.visible = false;
              this._showCameraErrorMessage(
                "Camera couldn't be started",
                "Try again",
                "The camera might be in use by another application."
              );
            }
            return true; // Keep the timeout active but don't try to load frames
          }
        }

        // Find newest frame file
        let newestFrame = this._findNewestFrame();

        if (newestFrame && newestFrame.index > this._lastProcessedFrame) {
          // Hide the spinner once we have frames
          if (this._spinner.visible) {
            this._spinner.visible = false;
          }

          // We have a new frame
          this._lastProcessedFrame = newestFrame.index;

          let file = Gio.File.new_for_path(newestFrame.path);
          if (file.query_exists(null)) {
            // Using a widget with background image to ensure it fills the container
            if (!this._imageWrapper || !this._imageWrapper.get_parent()) {
              this._imageWrapper = new St.Widget({
                style_class: "campeek-frame-image",
                x_expand: true,
                y_expand: true,
                width: 480,
                height: 270,
                style:
                  "background-size: cover; background-position: center; background-image: url('" +
                  file.get_uri() +
                  "'); clip-path: inset(0px round 12px);",
              });
              this._cameraOutput.add_child(this._imageWrapper);
            } else {
              // Just update the background image
              this._imageWrapper.style =
                "background-size: cover; background-position: center; background-image: url('" +
                file.get_uri() +
                "'); clip-path: inset(0px round 12px);";
            }

            // Ensure the container is also styled correctly
            if (this._cameraOutput) {
              this._cameraOutput.style = "clip-path: inset(0px round 12px);";
            }
            
            if (this._previewContainer) {
              this._previewContainer.style = "clip-path: inset(0px round 12px);";
            }

            this._cameraOutput.visible = true;
          }
        }
      } catch (e) {
        console.error(e, "Error refreshing frame");
      }

      return true;
    }

    _findNewestFrame() {
      try {
        let dir = Gio.File.new_for_path(this._framesDir);
        if (!dir.query_exists(null)) {
          return null;
        }

        let enumerator = dir.enumerate_children(
          "standard::name",
          Gio.FileQueryInfoFlags.NONE,
          null,
        );

        let newestIndex = -1;
        let newestPath = null;

        let info;
        while ((info = enumerator.next_file(null))) {
          let name = info.get_name();

          // Check if this is a frame file
          if (name.startsWith("frame_") && name.endsWith(".jpg")) {
            // Extract the index number
            let indexStr = name.substring(6, name.length - 4);
            let index = parseInt(indexStr);

            if (!isNaN(index) && index > newestIndex) {
              newestIndex = index;
              newestPath = GLib.build_filenamev([this._framesDir, name]);
            }
          }
        }

        return newestIndex >= 0
          ? { index: newestIndex, path: newestPath }
          : null;
      } catch (e) {
        console.error(e, "Error finding newest frame");
        return null;
      }
    }

    _stopCameraPreview() {
      // Kill the capture process
      if (this._tempDir) {
        try {
          let pidFile = Gio.File.new_for_path(
            GLib.build_filenamev([this._tempDir, "pid"]),
          );
          if (pidFile.query_exists(null)) {
            let [success, contents] = GLib.file_get_contents(
              pidFile.get_path(),
            );
            if (success) {
              // Fixed deprecated module usage (Issue #2)
              let pid = parseInt(new TextDecoder().decode(contents).trim());
              if (!isNaN(pid)) {
                // Kill the process and its children asynchronously
                let pkillProc = Gio.Subprocess.new(
                  ["pkill", "-P", pid.toString()],
                  Gio.SubprocessFlags.STDERR_SILENCE,
                );
                pkillProc.wait_async(null, () => {
                  let killProc = Gio.Subprocess.new(
                    ["kill", pid.toString()],
                    Gio.SubprocessFlags.STDERR_SILENCE,
                  );
                  killProc.wait_async(null, () => {});
                });
              }
            }
          }
        } catch (e) {
          console.error(e, "Error killing process");
        }
      }

      // Clear the refresh timeout
      if (this._refreshTimeout) {
        GLib.source_remove(this._refreshTimeout);
        this._refreshTimeout = 0;
      }

      // Clear the start timeout if active
      if (this._startTimeout) {
        GLib.source_remove(this._startTimeout);
        this._startTimeout = 0;
      }

      // Clean up the camera process
      if (this._cameraProcess) {
        try {
          this._cameraProcess.force_exit();
        } catch (e) {
          console.error(e);
        }
        this._cameraProcess = null;
      }

      // Clean up the camera output
      if (this._cameraOutput) {
        if (this._cameraOutput.get_parent()) {
          this._previewContainer.remove_child(this._cameraOutput);
        }
        this._cameraOutput = null;
      }

      // Clean up the image actor
      this._imageActor = null;
      this._imageWrapper = null;

      // Clean up any camera-in-use message
      if (this._cameraInUseMessage && this._cameraInUseMessage.get_parent()) {
        this._previewContainer.remove_child(this._cameraInUseMessage);
        this._cameraInUseMessage = null;
      }

      // Clean up the temporary directory with GJS/Gio
      if (this._tempDir) {
        try {
          // Kill any related processes asynchronously
          let proc = Gio.Subprocess.new(
            ["pkill", "-f", this._tempDir],
            Gio.SubprocessFlags.STDERR_SILENCE,
          );

          proc.wait_async(null, () => {
            // Now remove the directory and its contents
            let dir = Gio.File.new_for_path(this._tempDir);
            this._recursiveDelete(dir);

            this._tempDir = null;
            this._framesDir = null;
          });
        } catch (e) {
          console.error(e, "Error cleaning up");
        }
      }

      this._spinner.visible = false;

      // Try to kill any stray test processes 
      this._runCommand(
        ["pkill", "-f", "campeek-test-"],
        () => {}, // Don't wait for completion, it's best-effort cleanup
        {
          timeout: 1000,
          description: 'cleanup camera test processes'
        }
      );
    }

    _recursiveDelete(file) {
      try {
        // If it's a directory, delete contents first
        let fileType = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);

        if (fileType === Gio.FileType.DIRECTORY) {
          let children = file.enumerate_children(
            "standard::name",
            Gio.FileQueryInfoFlags.NONE,
            null,
          );
          let info;

          while ((info = children.next_file(null))) {
            let child = file.get_child(info.get_name());
            this._recursiveDelete(child);
          }
        }

        // Now delete the file/directory itself
        file.delete(null);
      } catch (e) {
        console.error("Error deleting file " + file.get_path() + ": " + e.message);
      }
    }

    // Centralized subprocess utility to reduce code duplication
    _runCommand(command, callback, options = {}) {
      try {
        const {
          timeout = 5000,
          silent = true,
          description = 'command'
        } = options;

        let proc = Gio.Subprocess.new(
          Array.isArray(command) ? command : ['bash', '-c', command],
          silent ? 
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE :
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );

        // Set up timeout if specified
        let timeoutId = null;
        if (timeout > 0) {
          timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
            try {
              proc.force_exit();
            } catch (e) {
              console.error("CamPeek: Error forcing exit of " + description + ":", e);
            }
            callback(false, '', "Timeout after " + timeout + "ms");
            return GLib.SOURCE_REMOVE;
          });
        }

        proc.communicate_utf8_async(null, null, (proc, result) => {
          try {
            // Clear timeout if it was set
            if (timeoutId) {
              GLib.source_remove(timeoutId);
            }

            let [, stdout, stderr] = proc.communicate_utf8_finish(result);
            let success = proc.get_successful();
            callback(success, stdout || '', stderr || '');
          } catch (e) {
            console.error("CamPeek: Error in " + description + ":", e);
            callback(false, '', e.message);
          }
        });
      } catch (e) {
        console.error("CamPeek: Error starting " + description + ":", e);
        callback(false, '', e.message);
      }
    }

    _removeAllPadding() {
      // Now implemented to properly adjust the styling
      if (this.menu.box) {
        // Apply styles directly to improve compatibility
        this.menu.box.style = "padding: 0; margin: 0;";

        // Find and style the popup-menu-content
        let content = this.menu.box.get_parent();
        if (
          content &&
          content.style_class &&
          content.style_class.includes("popup-menu-content")
        ) {
          content.style = "padding: 8px; margin: 0; border-radius: 12px; overflow: hidden;";
        }
      }
    }

    destroy() {
      // Restore original open function
      if (this._originalOpenMenuFunc) {
        this.menu.open = this._originalOpenMenuFunc;
      }

      // Clean up any pending camera tests
      if (this._pendingTestProcesses && this._pendingTestProcesses.length > 0) {
        this._pendingTestProcesses.forEach(item => {
          try {
            if (item.proc) {
              item.proc.force_exit();
            }
            // Clean up files asynchronously
            this._cleanupTestFiles(item.testFile, item.scriptPath);
          } catch (e) {
            console.error("CamPeek: Error cleaning up test process:", e);
          }
        });
        this._pendingTestProcesses = [];
      }
      
      // Clean up camera test timeout
      if (this._cameraTestTimeout) {
        GLib.source_remove(this._cameraTestTimeout);
        this._cameraTestTimeout = null;
      }
      
      // Clean up refresh timeout - this was missing before
      if (this._refreshTimeout) {
        GLib.source_remove(this._refreshTimeout);
        this._refreshTimeout = null;
      }
      
      // Try to kill any stray test processes 
      this._runCommand(
        ["pkill", "-f", "campeek-test-"],
        () => {}, // Don't wait for completion, it's best-effort cleanup
        {
          timeout: 1000,
          description: 'cleanup camera test processes'
        }
      );
      
      // Clean up test-related variables
      delete this._testedDevices;
      delete this._workingDevices;
      delete this._pendingDevices;
      delete this._pendingTestProcesses;
      delete this._cameraTestResults;
      delete this._cameraTestCount;
      delete this._camerasToTest;
      delete this._cameraSelectionComplete;

      // Clean up camera selection menu if it exists
      if (this._cameraSelectionMenu) {
        this._cameraSelectionMenu.close();
        this._cameraSelectionMenu = null;
      }

      // Clean up refresh list label timeout if active
      if (this._refreshListLabelTimeout) {
        GLib.source_remove(this._refreshListLabelTimeout);
        this._refreshListLabelTimeout = null;
      }

      // Clean up camera menu timeouts if active
      if (this._cameraMenuTimeoutId1) {
        GLib.source_remove(this._cameraMenuTimeoutId1);
        this._cameraMenuTimeoutId1 = null;
      }
      if (this._cameraMenuTimeoutId2) {
        GLib.source_remove(this._cameraMenuTimeoutId2);
        this._cameraMenuTimeoutId2 = null;
      }

      // Clean up menu style timeout if active
      if (this._menuStyleTimeout) {
        GLib.source_remove(this._menuStyleTimeout);
        this._menuStyleTimeout = null;
      }

      // Clean up position fix timeouts
      this._clearPositionFixTimeouts();

      // Clean up global click handler if active
      if (this._globalClickId) {
        global.stage.disconnect(this._globalClickId);
        this._globalClickId = null;
      }

      // Clean up outside click handler for camera selection menu
      if (this._outsideClickId) {
        global.stage.disconnect(this._outsideClickId);
        this._outsideClickId = null;
      }

      // Clean up start timeout if active
      if (this._startTimeout) {
        GLib.source_remove(this._startTimeout);
        this._startTimeout = null;
      }

      // Clean up retry timeout if active
      if (this._retryTimeout) {
        GLib.source_remove(this._retryTimeout);
        this._retryTimeout = null;
      }

      // Disconnect button-press-event signal handler
      if (this._buttonPressHandler) {
        this.disconnect(this._buttonPressHandler);
        this._buttonPressHandler = null;
      }

      this._stopCameraPreview();
      super.destroy();
    }

    _validateCameraDevice() {
      // Check if the current camera device exists
      let deviceFile = Gio.File.new_for_path(this._cameraDevice);
      if (!deviceFile.query_exists(null)) {
        console.log("CamPeek: Camera device " + this._cameraDevice + " does not exist, finding a valid one...");
        this._findAndTestCameras();
      } else {
        // Quick test to see if camera works - if not, find a working one
        this._testCameraQuick(this._cameraDevice, (works) => {
          if (!works) {
            console.log("CamPeek: Camera device " + this._cameraDevice + " exists but doesn't work");
            this._findAndTestCameras();
          }
          // No need to log if working
        });
      }
    }
    
    _findAndTestCameras() {
      try {
        // Get list of camera devices using multiple methods
        let commands = [
          // Primary method: list video devices
          'ls -1 /dev/video* 2>/dev/null',
          // Alternative method: use v4l2-ctl if available
          'v4l2-ctl --list-devices 2>/dev/null | grep -E "^/dev/video" | head -10',
          // Fallback: check common camera device paths
          'for i in {0..9}; do [ -e "/dev/video$i" ] && echo "/dev/video$i"; done'
        ];
        
        this._tryNextDetectionMethod(commands, 0);
      } catch (e) {
        console.error("CamPeek: Error finding camera devices:", e);
        // Fallback to default device
        this._fallbackToDefaultDevice();
      }
    }
    
    _tryNextDetectionMethod(commands, index) {
      if (index >= commands.length) {
        // All methods failed, try fallback
        this._fallbackToDefaultDevice();
        return;
      }
      
      const command = commands[index];
      console.log("CamPeek: Trying detection method " + (index + 1) + ": " + command);
      
      this._runCommand(command, (success, stdout, stderr) => {
        if (success && stdout && stdout.trim() !== "") {
          let devices = stdout.split("\n").filter(d => d && d.trim() !== "" && d.startsWith("/dev/video"));
          
          if (devices.length > 0) {
            console.log("CamPeek: Found " + devices.length + " potential camera device(s) using method " + (index + 1));
            this._testAllCameras(devices);
            return;
          }
        }
        
        // This method didn't work, try the next one
        this._tryNextDetectionMethod(commands, index + 1);
      }, {
        timeout: 3000,
        description: "detection method " + (index + 1)
      });
    }
    
    _fallbackToDefaultDevice() {
      console.log("CamPeek: No cameras detected, checking common device paths...");
      
      // Check expanded range of camera device paths for better compatibility
      let commonPaths = [
        '/dev/video0', '/dev/video1', '/dev/video2', '/dev/video3', '/dev/video4',
        '/dev/video5', '/dev/video6', '/dev/video7', '/dev/video8', '/dev/video9',
        '/dev/video10', '/dev/video11', '/dev/video12', '/dev/video13', '/dev/video14',
        '/dev/video15', '/dev/video16', '/dev/video17', '/dev/video18', '/dev/video19'
      ];
      let foundDevices = [];
      
      for (let path of commonPaths) {
        let deviceFile = Gio.File.new_for_path(path);
        if (deviceFile.query_exists(null)) {
          foundDevices.push(path);
        }
      }
      
      if (foundDevices.length > 0) {
        console.log("CamPeek: Found " + foundDevices.length + " device(s) in fallback check");
        this._testAllCameras(foundDevices);
      } else {
        console.log("CamPeek: No camera devices found at all");
        // Set to default anyway - user might connect a camera later
        this._cameraDevice = "/dev/video0";
        this._settings.set_string("camera-device", this._cameraDevice);
      }
    }

    _testAllCameras(devices) {
      // Early fallback if only one device exists
      if (devices.length === 1) {
        // No need to log for single device case - just use it
        this._cameraDevice = devices[0].trim();
        this._settings.set_string("camera-device", this._cameraDevice);
        return;
      }
      
      // Variables to track testing progress
      this._cameraTestResults = [];
      this._cameraTestCount = 0;
      this._camerasToTest = devices.length;
      this._cameraSelectionComplete = false;
      
      // Test all cameras in parallel
      devices.forEach(device => {
        this._testCameraQuick(device.trim(), (works) => {
          this._cameraTestCount++;
          
          if (works) {
            this._cameraTestResults.push({
              device: device.trim(),
              works: true
            });
          } else {
            this._cameraTestResults.push({
              device: device.trim(),
              works: false
            });
          }
          
          // When all tests complete, pick the first working camera
          if (this._cameraTestCount >= this._camerasToTest) {
            this._selectWorkingCamera();
          }
        });
      });
      
      // Set a timeout in case some tests hang
      this._cameraTestTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
        if (this._cameraTestCount < this._camerasToTest) {
          this._selectWorkingCamera();
        }
        this._cameraTestTimeout = null;
        return GLib.SOURCE_REMOVE;
      });
    }
    
    _selectWorkingCamera() {
      // Prevent multiple calls
      if (this._cameraSelectionComplete) {
        return;
      }
      this._cameraSelectionComplete = true;
      
      // Clear timeout if it exists
      if (this._cameraTestTimeout) {
        GLib.source_remove(this._cameraTestTimeout);
        this._cameraTestTimeout = null;
      }
      
      // Find first working camera
      let workingCamera = this._cameraTestResults.find(result => result.works);
      
      if (workingCamera) {
        // Only log if the camera is changing
        if (workingCamera.device !== this._cameraDevice) {
          console.log("CamPeek: Selected working camera: " + workingCamera.device);
        }
        this._cameraDevice = workingCamera.device;
        this._settings.set_string("camera-device", workingCamera.device);
      } else {
        // Fallback to first device if none work
        if (this._cameraTestResults.length > 0 && 
            this._cameraTestResults[0].device !== this._cameraDevice) {
          console.log("CamPeek: No working cameras found, defaulting to first device");
          this._cameraDevice = this._cameraTestResults[0].device;
          this._settings.set_string("camera-device", this._cameraDevice);
        }
      }
      
      // Clean up
      delete this._cameraTestResults;
      delete this._cameraTestCount;
      delete this._camerasToTest;
      delete this._cameraSelectionComplete;
    }

    _showCameraErrorMessage(title, message, details) {
      // Hide the spinner
      this._spinner.visible = false;

      // Create and show the camera-in-use message
      this._cameraInUseMessage = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      // Add an icon
      let icon = new St.Icon({
        icon_name: "camera-disabled-symbolic",
        icon_size: 48,
        style_class: "camera-in-use-icon",
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._cameraInUseMessage.add_child(icon);

      // Add a title
      let titleLabel = new St.Label({
        text: title,
        style_class: "camera-in-use-title",
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._cameraInUseMessage.add_child(titleLabel);

      // Add a message
      let messageLabel = new St.Label({
        text: message,
        style_class: "camera-in-use-message",
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._cameraInUseMessage.add_child(messageLabel);

      // Add details
      let detailsLabel = new St.Label({
        text: details,
        style_class: "camera-in-use-details",
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._cameraInUseMessage.add_child(detailsLabel);

      // Add a retry button
      let buttonBox = new St.BoxLayout({
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "camera-retry-box",
      });

      let button = new St.Button({
        label: "Try Again",
        style_class: "camera-retry-button button",
        x_align: Clutter.ActorAlign.CENTER,
      });

      // Improved retry logic with better error handling
      button.connect("clicked", () => {
        // First make sure we clean up any existing message
        if (this._cameraInUseMessage && this._cameraInUseMessage.get_parent()) {
          this._previewContainer.remove_child(this._cameraInUseMessage);
          this._cameraInUseMessage = null;
        }

        // Make sure the spinner is visible before trying to start the camera
        this._spinner.visible = true;

        // Add a slight delay to ensure UI updates before trying camera again
        this._retryTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
          try {
            // Try to start the camera preview again
            this._startCameraPreview();
          } catch (e) {
            // If anything fails, make sure we show an error
            console.error("Error during retry:", e);
            this._spinner.visible = false;
            this._showCameraErrorMessage(
              "Failed to restart camera",
              "Try again",
              e.message
            );
          }
          this._retryTimeout = null;
          return GLib.SOURCE_REMOVE;
        });
      });

      buttonBox.add_child(button);
      this._cameraInUseMessage.add_child(buttonBox);

      // Add to container
      this._previewContainer.add_child(this._cameraInUseMessage);
    }
  },
);

export default class CamPeekExtension extends Extension {
  enable() {
    this._indicator = new CamPeekIndicator(this);
    Main.panel.addToStatusArea("campeek", this._indicator, 0, "right");
  }

  disable() {
    this._indicator.destroy();
    this._indicator = null;
  }

  getSettings() {
    // Use the Extension class's correct method
    return super.getSettings("org.gnome.shell.extensions.campeek");
  }
}
