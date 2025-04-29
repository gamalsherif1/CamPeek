/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from "gi://GObject";
import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import Gtk from "gi://Gtk?version=4.0";
import GdkPixbuf from "gi://GdkPixbuf";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const CamPeekIndicator = GObject.registerClass(
  class CamPeekIndicator extends PanelMenu.Button {
    _init(extension) {
      super._init(0.0, "CamPeek");

      this._extension = extension;

      // Create a box for the icon
      let topBox = new St.BoxLayout({
        style_class: "panel-status-menu-box",
      });

      // Use the icon from the specified path
      let iconPath = this._extension.path + "/icons/mirror.png";
      log("CamPeek: Looking for icon at " + iconPath);

      // Try to load the custom icon with error checking
      let iconFile = Gio.File.new_for_path(iconPath);
      let gicon = null;

      try {
        if (iconFile.query_exists(null)) {
          gicon = new Gio.FileIcon({ file: iconFile });
          log("CamPeek: Custom icon loaded successfully from " + iconPath);
        } else {
          log("CamPeek: Icon file does not exist at: " + iconPath);
        }
      } catch (e) {
        logError(e, "CamPeek: Error loading custom icon");
      }

      // Add the icon to the panel with fallback
      this._icon = new St.Icon({
        gicon: gicon,
        icon_name: gicon ? null : "camera-web-symbolic", // Fallback if gicon is null
        style_class: "system-status-icon",
        icon_size: 16,
      });

      // Add the icon to the box
      topBox.add_child(this._icon);

      // Add the box to the button
      this.add_child(topBox);

      // Clear all default menu items if any exist
      this.menu.removeAll();

      // Create a container for the camera preview with 3:2 aspect ratio
      this._previewContainer = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
        width: 480, // 3:2 aspect ratio (480:320)
        height: 320, // 3:2 aspect ratio
        style_class: "campeek-video-container",
      });

      // Add a box layout to contain the preview
      this._directBox = new St.BoxLayout({
        vertical: true,
        style_class: "campeek-direct-box",
        x_expand: true,
        y_expand: true,
      });
      this._directBox.add_child(this._previewContainer);

      // Add the box to the menu
      this.menu.box.add_child(this._directBox);

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

      // Configure menu position to appear directly under the icon
      this.menu.setSourceAlignment(0.5); // Center align the menu with the button

      // Make sure the menu appears below the icon
      if (this.menu._boxPointer) {
        this.menu._boxPointer._arrowSide = St.Side.TOP;
      }

      // Connect to menu opening and closing signals
      this.menu.connect("open-state-changed", (menu, isOpen) => {
        if (isOpen) {
          this._startCameraPreview();

          // Apply styling to menu after it's opened
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            this._removeAllPadding();
            return GLib.SOURCE_REMOVE;
          });
        } else {
          this._stopCameraPreview();
        }
      });

      this._cameraProcess = null;
      this._refreshTimeout = null;
      this._cameraOutput = null;
    }

    _removeAllPadding() {
      // Make everything completely transparent except the video
      if (this.menu && this.menu.box) {
        let parent = this.menu.box.get_parent();
        if (parent) {
          parent.style =
            "padding: 0; margin: 0; border: none; background-color: transparent; box-shadow: none; border-radius: 0;";
        }
        this.menu.box.style =
          "padding: 0; margin: 0; background-color: transparent; border: none;";

        // Add minimal border to container
        if (this._previewContainer) {
          this._previewContainer.style =
            "background-color: transparent; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 0; box-shadow: none; overflow: hidden;";
        }

        // Ensure the camera output has no border
        if (this._cameraOutput) {
          this._cameraOutput.style =
            "border: none; margin: 0; padding: 0; background: none;";
        }
      }
    }

    _startCameraPreview() {
      if (this._cameraProcess) {
        return; // Camera already running
      }

      this._spinner.visible = true;

      try {
        // Create a temporary directory for our frames
        let tempDir = GLib.build_filenamev([
          GLib.get_tmp_dir(),
          `campeek-frames-${GLib.random_int()}`,
        ]);
        this._tempDir = tempDir;

        // Ensure the directory exists
        GLib.mkdir_with_parents(tempDir, 0o755);

        // Create an image actor to display frames
        if (!this._cameraOutput) {
          this._cameraOutput = new St.Icon({
            gicon: null,
            x_expand: true,
            y_expand: true,
            icon_size: 480, // Match the width of the container
            style_class: "campeek-frame",
          });
          this._previewContainer.add_child(this._cameraOutput);
        }

        // We'll use a sequence of numbered files
        this._frameIndex = 0;
        this._framesDir = GLib.build_filenamev([tempDir, "frames"]);
        GLib.mkdir_with_parents(this._framesDir, 0o755);

        // Create a script that uses GStreamer for more efficient frame capture with 3:2 aspect ratio
        let scriptPath = GLib.build_filenamev([tempDir, "capture.sh"]);
        let scriptContent = `#!/bin/bash

# Store the process ID
echo $$ > "${tempDir}/pid"

# Clean up any existing frames
rm -f ${this._framesDir}/frame_*.jpg 2>/dev/null

# Use GStreamer for frame capture with 3:2 aspect ratio (480x320)
gst-launch-1.0 v4l2src device=/dev/video0 ! \
videoconvert ! videoscale ! video/x-raw,width=480,height=320,framerate=30/1 ! \
queue max-size-buffers=2 leaky=downstream ! \
videoflip method=horizontal-flip ! jpegenc quality=85 ! \
multifilesink location="${this._framesDir}/frame_%05d.jpg" max-files=5 post-messages=true
`;

        // Write the script to a file
        GLib.file_set_contents(scriptPath, scriptContent);
        GLib.chmod(scriptPath, 0o755);

        // Launch the script to start capturing frames
        this._cameraProcess = Gio.Subprocess.new(
          ["/bin/bash", scriptPath],
          Gio.SubprocessFlags.NONE,
        );

        // Reset frame counter
        this._lastProcessedFrame = -1;

        // Start a refresh timer with higher priority for better performance
        this._refreshTimeout = GLib.timeout_add(
          GLib.PRIORITY_HIGH,
          1000 / 30, // Target 30fps refresh
          () => {
            this._refreshFrame();
            return GLib.SOURCE_CONTINUE;
          },
        );

        // Set a timeout to check if camera started successfully
        this._startTimeout = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          5000,
          () => {
            if (this._spinner.visible) {
              this._spinner.visible = false;
            }
            this._startTimeout = 0;
            return GLib.SOURCE_REMOVE;
          },
        );
      } catch (e) {
        logError(e, "Error starting camera");
        this._spinner.visible = false;
      }
    }

    _refreshFrame() {
      try {
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
            // Create a new FileIcon
            let gicon = new Gio.FileIcon({ file: file });

            // Update the existing camera output instead of recreating it
            if (!this._cameraOutput || !this._cameraOutput.get_parent()) {
              // If we don't have a camera output yet, create one
              this._cameraOutput = new St.Icon({
                gicon: gicon,
                x_expand: true,
                y_expand: true,
                icon_size: 480, // Match the width of the container
                style_class: "campeek-frame",
              });
              this._previewContainer.add_child(this._cameraOutput);
              // Apply no border style immediately
              this._cameraOutput.style =
                "border: none; margin: 0; padding: 0; background: none;";
            } else {
              // Just update the gicon of the existing St.Icon
              this._cameraOutput.set_gicon(gicon);
            }

            this._cameraOutput.visible = true;
          }
        }
      } catch (e) {
        logError(e, "Error refreshing frame");
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
        logError(e, "Error finding newest frame");
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
              let pid = parseInt(imports.byteArray.toString(contents).trim());
              if (!isNaN(pid)) {
                // Kill the process and its children
                GLib.spawn_command_line_sync(
                  `pkill -P ${pid} 2>/dev/null || true`,
                );
                GLib.spawn_command_line_sync(`kill ${pid} 2>/dev/null || true`);
              }
            }
          }
        } catch (e) {
          logError(e, "Error killing process");
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
          logError(e);
        }
        this._cameraProcess = null;
      }

      // Clean up the camera output
      if (this._cameraOutput) {
        if (this._cameraOutput.get_parent()) {
          this._previewContainer.remove_child(this._cameraOutput);
        }
        this._cameraOutput.destroy();
        this._cameraOutput = null;
      }

      // Clean up the temporary directory
      if (this._tempDir) {
        try {
          // Make sure all related processes are dead
          GLib.spawn_command_line_sync(
            `pkill -f "${this._tempDir}" 2>/dev/null || true`,
          );

          // Remove the directory and all contents
          GLib.spawn_command_line_sync(`rm -rf "${this._tempDir}"`);
          this._tempDir = null;
          this._framesDir = null;
        } catch (e) {
          logError(e, "Error cleaning up");
        }
      }

      this._spinner.visible = false;
    }

    destroy() {
      this._stopCameraPreview();
      super.destroy();
    }
  },
);

export default class CamPeekExtension extends Extension {
  enable() {
    this._indicator = new CamPeekIndicator(this);
    Main.panel.addToStatusArea("campeek", this._indicator);

    // Load the stylesheet for smooth transitions
    this._loadStylesheet();
  }

  _loadStylesheet() {
    let theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.load_stylesheet(this.path + "/stylesheet.css");
  }

  disable() {
    // Unload the stylesheet
    let theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.unload_stylesheet(this.path + "/stylesheet.css");

    this._indicator.destroy();
    this._indicator = null;
  }
}
