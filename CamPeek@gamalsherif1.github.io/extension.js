// extension.js - With camera selection menu - Fixed menu behavior

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
      // Call parent constructor with more explicit parameters
      super._init(0.5, "CamPeek", false);

      this._extension = extension;

      // Get settings
      this._settings = extension.getSettings();

      // Get saved camera device or use default
      this._cameraDevice = this._settings.get_string("camera-device");
      if (!this._cameraDevice) {
        this._cameraDevice = "/dev/video0";
      }

      // Set up a container for the icon with explicit centering
      let topBox = new St.BoxLayout({
        style_class: "panel-status-menu-box campeek-box",
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      // Use the icon from the specified path
      let iconPath = this._extension.path + "/icons/mirror.png";

      // Try to load the custom icon
      let iconFile = Gio.File.new_for_path(iconPath);
      let gicon = null;

      try {
        if (iconFile.query_exists(null)) {
          gicon = new Gio.FileIcon({ file: iconFile });
        }
      } catch (e) {
        console.error(e, "CamPeek: Error loading custom icon");
      }

      // Add the icon to the panel with fallback and explicit centering
      this._icon = new St.Icon({
        gicon: gicon,
        icon_name: gicon ? null : "camera-web-symbolic", // Fallback if gicon is null
        style_class: "system-status-icon campeek-icon",
        icon_size: 16,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      // Add the icon to the box
      topBox.add_child(this._icon);

      // Use bin layout for the button to ensure centering
      this.set_layout_manager(new Clutter.BinLayout());
      this.add_style_class_name("campeek-button");
      this.add_child(topBox);

      // Configure the menu
      this.menu.removeAll();

      // Override the default menu opening mechanism
      this._originalOpenMenuFunc = this.menu.open;
      this.menu.open = (animate) => {
        // Close the camera selection menu if it's open
        if (this._cameraSelectionMenu && this._cameraSelectionMenu.isOpen) {
          // Disconnect the outside click handler
          if (this._outsideClickId) {
            global.stage.disconnect(this._outsideClickId);
            this._outsideClickId = null;
          }
          this._cameraSelectionMenu.close();
        }
        
        // First call the original method
        this._originalOpenMenuFunc.call(this.menu, animate);

        // Schedule multiple adjustment attempts to ensure centering
        this._scheduleMenuPositionFix();
      };

      // Create a menu item to contain the camera preview
      let previewItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        style_class: "campeek-preview-item",
      });
      this.menu.addMenuItem(previewItem);

      // Create a container for the camera preview
      this._previewContainer = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
        width: 480,
        height: 270,
      });

      // Add the preview container to the menu item
      previewItem.add_child(this._previewContainer);

      // Add a spinner for loading state
      this._spinner = new St.Icon({
        icon_name: "content-loading-symbolic",
        style_class: "spinner",
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._previewContainer.add_child(this._spinner);

      // Setup menu arrow and alignment
      if (this.menu._boxPointer) {
        this.menu._boxPointer._arrowSide = St.Side.TOP;
        this.menu._boxPointer.setSourceAlignment(0.5);
      }

      // Track timeouts
      this._menuStyleTimeout = null;
      this._positionFixTimeouts = [];
      this._globalClickId = null;
      this._buttonPressHandler = null;
      this._outsideClickId = null;
      
      // Track camera selection menu state
      this._cameraSelectionMenu = null;

      // Add click-outside handling for the main menu
      this.menu.actor.connect("button-press-event", (actor, event) => {
        // If we detect a click outside the menu area
        if (event.get_source() !== actor) {
          this.menu.close();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      // Connect to menu open-state-changed signal
      this.menu.connect("open-state-changed", (menu, isOpen) => {
        if (isOpen) {
          this._startCameraPreview();

          // Clear existing timeout before setting a new one
          if (this._menuStyleTimeout) {
            GLib.source_remove(this._menuStyleTimeout);
            this._menuStyleTimeout = null;
          }

          // Apply styling to menu
          this._menuStyleTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            10,
            () => {
              this._removeAllPadding();
              this._menuStyleTimeout = null;
              return GLib.SOURCE_REMOVE;
            },
          );

          // Add global click handler
          this._globalClickId = global.stage.connect(
            "button-press-event",
            (actor, event) => {
              // Close menu when clicking outside
              if (this.menu.isOpen) {
                this.menu.close();
              }
            },
          );
        } else {
          this._stopCameraPreview();

          // Clean up any position fix timeouts
          this._clearPositionFixTimeouts();

          // Remove global click handler
          if (this._globalClickId) {
            global.stage.disconnect(this._globalClickId);
            this._globalClickId = null;
          }
        }
      });

      // Add button-press-event handler for right-click
      this._buttonPressHandler = (actor, event) => {
        // Check if it's right button (button 3)
        if (event.get_button() === 3) {
          // Prevent the default behavior (which might trigger the left-click menu)
          this._showCameraSelectionMenu();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      };
      this.connect("button-press-event", this._buttonPressHandler);

      this._cameraProcess = null;
      this._refreshTimeout = null;
      this._cameraOutput = null;
      this._imageActor = null;
      this._imageWrapper = null;
      this._cameraInUseMessage = null;
    }

    _showCameraSelectionMenu() {
      // If the camera selection menu is already open, don't create a new one
      if (this._cameraSelectionMenu && this._cameraSelectionMenu.isOpen) {
        return;
      }
      
      // Close the preview menu if it's open to prevent both menus appearing
      if (this.menu.isOpen) {
        this.menu.close();
      }
      
      // Create a new menu for camera selection
      let cameraMenu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
      this._cameraSelectionMenu = cameraMenu;

      // Add available cameras to the menu
      this._populateCameraMenu(cameraMenu);

      // Position the menu
      Main.uiGroup.add_child(cameraMenu.actor);
      cameraMenu.open(true); // true = with animation

      // Add a global click handler to close the menu when clicking outside
      this._outsideClickId = global.stage.connect('button-press-event', (actor, event) => {
        if (this._cameraSelectionMenu && this._cameraSelectionMenu.isOpen) {
          this._cameraSelectionMenu.close();
        }
      });

      // Close the menu when a selection is made or closed
      cameraMenu.connect("open-state-changed", (menu, isOpen) => {
        if (!isOpen) {
          // Disconnect the outside click handler
          if (this._outsideClickId) {
            global.stage.disconnect(this._outsideClickId);
            this._outsideClickId = null;
          }
          
          Main.uiGroup.remove_child(menu.actor);
          menu.destroy();
          
          // Clear the reference
          if (this._cameraSelectionMenu === menu) {
            this._cameraSelectionMenu = null;
          }
        }
      });
      
      // Use GNOME Shell's built-in menu management
      Main.panel.menuManager.addMenu(cameraMenu);
    }

    _populateCameraMenu(menu) {
      // Add a title item
      let titleItem = new PopupMenu.PopupMenuItem(_("Select Camera Device"));
      titleItem.setSensitive(false);
      menu.addMenuItem(titleItem);

      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      // Find available cameras
      let cameras = this._findAvailableCameras();

      // Add each camera to the menu
      let activeCamera = this._cameraDevice;
      cameras.forEach((camera) => {
        let isActive = camera.device === activeCamera;
        let item = new PopupMenu.PopupMenuItem(camera.label);

        // Mark the current active camera
        if (isActive) {
          item.setOrnament(PopupMenu.Ornament.DOT);
        }

        item.connect("activate", () => {
          this._selectCamera(camera.device);
        });

        menu.addMenuItem(item);
      });

      // Add a refresh option at the bottom
      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      let refreshItem = new PopupMenu.PopupMenuItem(_("Refresh Camera List"));
      refreshItem.connect("activate", () => {
        menu.close();
        this._showCameraSelectionMenu();
      });
      menu.addMenuItem(refreshItem);
    }

    _findAvailableCameras() {
      let cameras = [];

      try {
        // Use GLib to execute a shell command to find cameras
        let [success, stdout, stderr] =
          GLib.spawn_command_line_sync("ls -1 /dev/video*");

        if (success) {
          // Convert the output to a string
          let deviceOutput = new TextDecoder().decode(stdout).trim();
          let devices = deviceOutput.split("\n");

          // Add each found device
          devices.forEach((device, index) => {
            if (device) {
              // Try to get a friendly name (this is basic - could be enhanced)
              let friendlyName = `Camera ${index}`;

              // Add to our list
              cameras.push({
                device: device,
                label: `${friendlyName} (${device})`,
              });
            }
          });
        }
      } catch (e) {
        console.error("Error finding cameras:", e);
      }

      // If no cameras found, add a placeholder
      if (cameras.length === 0) {
        cameras.push({
          device: "/dev/video0",
          label: "Default Camera (/dev/video0)",
        });
      }

      return cameras;
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

      // Schedule multiple position fixes at different times
      // to ensure it works even if the menu changes size
      [0, 50, 100, 250, 500].forEach((delay) => {
        let id = GLib.timeout_add(GLib.PRIORITY_HIGH, delay, () => {
          this._fixMenuPosition();

          // Remove this timeout from our tracking array
          this._positionFixTimeouts = this._positionFixTimeouts.filter(
            (t) => t !== id,
          );
          return GLib.SOURCE_REMOVE;
        });

        this._positionFixTimeouts.push(id);
      });
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

        // Also try to adjust the arrow position
        if (this.menu._boxPointer && this.menu._boxPointer._arrowOrigin) {
          this.menu._boxPointer._arrowOrigin.set_x_align(
            Clutter.ActorAlign.CENTER,
          );
        }
      } catch (e) {
        console.error("Error fixing menu position:", e);
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

      // Skip all camera checks and directly try to start the camera
      this._actuallyStartCamera();
    }

    _actuallyStartCamera() {
      try {
        // Create a temporary directory for our frames
        let tempDir = GLib.build_filenamev([
          GLib.get_tmp_dir(),
          `campeek-frames-${GLib.random_int()}`,
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
          });
          this._previewContainer.add_child(this._cameraOutput);
        }

        // We'll use a sequence of numbered files
        this._frameIndex = 0;
        this._framesDir = GLib.build_filenamev([tempDir, "frames"]);
        GLib.mkdir_with_parents(this._framesDir, 0o755);

        // Create a script that uses GStreamer for more efficient frame capture with 16:9 aspect ratio
        let scriptPath = GLib.build_filenamev([tempDir, "capture.sh"]);
        let scriptContent = `#!/bin/bash

# Store the process ID
echo $$ > "${tempDir}/pid"

# Clean up any existing frames
rm -f ${this._framesDir}/frame_*.jpg 2>/dev/null

# Use GStreamer for frame capture with 16:9 aspect ratio (480x270)
gst-launch-1.0 v4l2src device=${this._cameraDevice} ! \
videoconvert ! videoscale add-borders=false ! video/x-raw,width=480,height=270,framerate=30/1 ! \
queue max-size-buffers=2 leaky=downstream ! \
videoflip method=horizontal-flip ! jpegenc quality=85 ! \
multifilesink location="${this._framesDir}/frame_%05d.jpg" max-files=5 post-messages=true || \
(echo "ERROR" > "${tempDir}/camera_error" && exit 1)
`;

        // Write the script to a file
        let bytes = new TextEncoder().encode(scriptContent);
        let file = Gio.File.new_for_path(scriptPath);

        let outputStream = file.replace(
          null,
          false,
          Gio.FileCreateFlags.NONE,
          null,
        );

        outputStream.write_bytes(new GLib.Bytes(bytes), null);
        outputStream.close(null);

        // Set executable permission
        let info = file.query_info(
          "unix::mode",
          Gio.FileQueryInfoFlags.NONE,
          null,
        );
        let mode = info.get_attribute_uint32("unix::mode");
        info.set_attribute_uint32("unix::mode", mode | 0o100); // Add executable bit
        file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);

        // Launch the script to start capturing frames
        this._cameraProcess = Gio.Subprocess.new(
          ["/bin/bash", scriptPath],
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

        // Set a timeout to check if camera started successfully - reduced to 2 seconds
        this._startTimeout = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          2000, // Reduced from 5000 to 2000 ms
          () => {
            if (this._spinner.visible) {
              this._spinner.visible = false;
              this._showCameraErrorMessage(
                "Camera couldn't be started. It might be in use by another application.",
              );
            }
            this._startTimeout = 0;
            return GLib.SOURCE_REMOVE;
          },
        );
      } catch (e) {
        console.error(e, "Error starting camera");
        this._spinner.visible = false;
        this._showCameraErrorMessage("Error starting camera: " + e.message);
      }
    }

    _showCameraErrorMessage(message) {
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

      // Add a message
      let label = new St.Label({
        text:
          message ||
          "Camera is currently in use. Please close it and try again.",
        style_class: "camera-in-use-message",
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._cameraInUseMessage.add_child(label);

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
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
          try {
            // Try to start the camera preview again
            this._startCameraPreview();
          } catch (e) {
            // If anything fails, make sure we show an error
            console.error("Error during retry:", e);
            this._spinner.visible = false;
            this._showCameraErrorMessage(
              "Failed to restart camera. It may still be in use.",
            );
          }
          return GLib.SOURCE_REMOVE;
        });
      });

      buttonBox.add_child(button);
      this._cameraInUseMessage.add_child(buttonBox);

      // Add to container
      this._previewContainer.add_child(this._cameraInUseMessage);
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
                "Camera couldn't be started. It might be in use by another application.",
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
            // Create a clean URI for the file
            let fileUri = file.get_uri();
            
            // Using a widget with background image to ensure it fills the container
            if (!this._imageWrapper || !this._imageWrapper.get_parent()) {
              this._imageWrapper = new St.Widget({
                style_class: "campeek-frame-image",
                x_expand: true,
                y_expand: true,
                width: 480,
                height: 270,
              });
              
              // Set background properties individually to avoid parsing issues
              this._imageWrapper.set_style(
                "background-size: cover;" + 
                "background-position: center;" + 
                "background-image: url('" + fileUri + "');"
              );
              
              this._cameraOutput.add_child(this._imageWrapper);
            } else {
              // Update background image with clean styling
              this._imageWrapper.set_style(
                "background-size: cover;" + 
                "background-position: center;" + 
                "background-image: url('" + fileUri + "');"
              );
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
        console.error(`Error deleting file ${file.get_path()}: ${e.message}`);
      }
    }
    _removeAllPadding() {
      // Now implemented to properly adjust the styling
      if (this.menu.box) {
        // Apply styles using the proper set_style method
        this.menu.box.set_style("padding: 0; margin: 0;");

        // Find and style the popup-menu-content
        let content = this.menu.box.get_parent();
        if (
          content &&
          content.style_class &&
          content.style_class.includes("popup-menu-content")
        ) {
          content.set_style("padding: 8px; margin: 0; border-radius: 12px;");
        }
      }
    }

    destroy() {
      // Restore original open function
      if (this._originalOpenMenuFunc) {
        this.menu.open = this._originalOpenMenuFunc;
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

      // Disconnect button-press-event signal handler
      if (this._buttonPressHandler) {
        this.disconnect_by_func(this._buttonPressHandler);
        this._buttonPressHandler = null;
      }

      this._stopCameraPreview();
      super.destroy();
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
