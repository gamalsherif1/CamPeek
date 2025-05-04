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
// Removed unused GdkPixbuf import (Issue #3)

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
      console.log("CamPeek: Looking for icon at " + iconPath);

      // Try to load the custom icon with error checking
      let iconFile = Gio.File.new_for_path(iconPath);
      let gicon = null;

      try {
        if (iconFile.query_exists(null)) {
          gicon = new Gio.FileIcon({ file: iconFile });
          console.log(
            "CamPeek: Custom icon loaded successfully from " + iconPath,
          );
        } else {
          console.log("CamPeek: Icon file does not exist at: " + iconPath);
        }
      } catch (e) {
        console.error(e, "CamPeek: Error loading custom icon");
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

      // Create a menu item to contain the camera preview
      let previewItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        style_class: "campeek-preview-item",
      });
      this.menu.addMenuItem(previewItem);

      // Create a container for the camera preview with 16:9 aspect ratio
      this._previewContainer = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
        width: 480, // 16:9 aspect ratio (480:270)
        height: 270, // 16:9 aspect ratio
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

      // Configure menu position to appear directly under the icon
      this.menu.setSourceAlignment(0.5); // Center align the menu with the button

      // Make sure the menu appears below the icon
      if (this.menu._boxPointer) {
        this.menu._boxPointer._arrowSide = St.Side.TOP;
      }

      // Track menu timeout (for Issue #1)
      this._menuStyleTimeout = null;

      // Connect to menu opening and closing signals
      this.menu.connect("open-state-changed", (menu, isOpen) => {
        if (isOpen) {
          this._startCameraPreview();

          // Clear existing timeout before setting a new one
          if (this._menuStyleTimeout) {
            GLib.source_remove(this._menuStyleTimeout);
            this._menuStyleTimeout = null;
          }

          // Apply styling to menu after it's opened - now tracked for cleanup
          this._menuStyleTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            10,
            () => {
              this._removeAllPadding();
              this._menuStyleTimeout = null;
              return GLib.SOURCE_REMOVE;
            },
          );
        } else {
          this._stopCameraPreview();
        }
      });

      this._cameraProcess = null;
      this._refreshTimeout = null;
      this._cameraOutput = null;
      this._cameraInUseMessage = null;
      this._lastCameraCheck = null;
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

      // Check if camera is already in use
      this._checkCameraAvailability((isAvailable) => {
        if (isAvailable) {
          // Camera is available, proceed with normal camera startup
          this._actuallyStartCamera();
        } else {
          // Camera is in use, show message
          this._showCameraInUseMessage();
        }
      });
    }

    _checkCameraAvailability(callback) {
      // Add caching to avoid frequent repeated checks
      const now = GLib.get_monotonic_time() / 1000; // Convert to milliseconds
      if (this._lastCameraCheck && now - this._lastCameraCheck.time < 2000) {
        // Use cached result if it's less than 2 seconds old
        callback(this._lastCameraCheck.isAvailable);
        return;
      }

      try {
        // Use lsof which is much faster than v4l2-ctl for checking device usage
        let proc = Gio.Subprocess.new(
          ["lsof", "/dev/video0"],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );

        proc.communicate_utf8_async(null, null, (proc, result) => {
          try {
            let [, stdout, stderr] = proc.communicate_utf8_finish(result);
            let exitStatus = proc.get_exit_status();

            // If lsof returns exit code 0, it found processes using the camera
            // Exit code 1 means no processes are using it (it's available)
            let isAvailable = exitStatus === 1;

            // Cache the result
            this._lastCameraCheck = {
              time: GLib.get_monotonic_time() / 1000,
              isAvailable: isAvailable,
            };

            callback(isAvailable);
          } catch (e) {
            console.error("CamPeek: Error checking camera with lsof:", e);
            this._tryFastCameraOpen(callback);
          }
        });
      } catch (e) {
        console.error("CamPeek: Error initiating camera check:", e);
        this._tryFastCameraOpen(callback);
      }
    }

    _tryFastCameraOpen(callback) {
      try {
        // Much faster than previous method:
        // - Shorter timeout (0.5s instead of 2s)
        // - Only one buffer requested
        let testProc = Gio.Subprocess.new(
          [
            "timeout",
            "0.5",
            "gst-launch-1.0",
            "v4l2src",
            "device=/dev/video0",
            "num-buffers=1",
            "!",
            "fakesink",
          ],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );

        testProc.communicate_utf8_async(null, null, (proc, result) => {
          try {
            let [, stdout, stderr] = proc.communicate_utf8_finish(result);
            let exitStatus = proc.get_exit_status();

            // Cache the result
            let isAvailable = exitStatus === 0;
            this._lastCameraCheck = {
              time: GLib.get_monotonic_time() / 1000,
              isAvailable: isAvailable,
            };

            callback(isAvailable);
          } catch (e) {
            console.error("CamPeek: Error in camera test:", e);
            callback(false);
          }
        });
      } catch (e) {
        console.error("CamPeek: Error setting up camera test:", e);
        callback(false);
      }
    }

    _showCameraInUseMessage() {
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
        text: "Camera is currently in use by another application",
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

      button.connect("clicked", () => {
        this._previewContainer.remove_child(this._cameraInUseMessage);
        this._cameraInUseMessage = null;
        this._startCameraPreview();
      });

      buttonBox.add_child(button);
      this._cameraInUseMessage.add_child(buttonBox);

      // Add to container
      this._previewContainer.add_child(this._cameraInUseMessage);
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

        // Create a script that uses GStreamer for more efficient frame capture with 16:9 aspect ratio
        let scriptPath = GLib.build_filenamev([tempDir, "capture.sh"]);
        let scriptContent = `#!/bin/bash

# Store the process ID
echo $$ > "${tempDir}/pid"

# Clean up any existing frames
rm -f ${this._framesDir}/frame_*.jpg 2>/dev/null

# Use GStreamer for frame capture with 16:9 aspect ratio (480x270)
gst-launch-1.0 v4l2src device=/dev/video0 ! \
videoconvert ! videoscale ! video/x-raw,width=480,height=270,framerate=30/1 ! \
queue max-size-buffers=2 leaky=downstream ! \
videoflip method=horizontal-flip ! jpegenc quality=85 ! \
multifilesink location="${this._framesDir}/frame_%05d.jpg" max-files=5 post-messages=true
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

        // Set a timeout to check if camera started successfully
        this._startTimeout = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          5000,
          () => {
            if (this._spinner.visible) {
              this._spinner.visible = false;

              // If spinner is still visible after 5 seconds, camera likely failed to start
              // Show a message indicating camera might be in use
              this._showCameraInUseMessage();
            }
            this._startTimeout = 0;
            return GLib.SOURCE_REMOVE;
          },
        );
      } catch (e) {
        console.error(e, "Error starting camera");
        this._spinner.visible = false;
        this._showCameraInUseMessage();
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
            } else {
              // Just update the gicon of the existing St.Icon
              this._cameraOutput.set_gicon(gicon);
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
        // Apply styles directly to improve compatibility
        this.menu.box.style = "padding: 0; margin: 0;";

        // Find and style the popup-menu-content
        let content = this.menu.box.get_parent();
        if (
          content &&
          content.style_class &&
          content.style_class.includes("popup-menu-content")
        ) {
          content.style = "padding: 8px; margin: 0; border-radius: 12px;";
        }
      }
    }

    destroy() {
      // Fix for Issue #1: Clean up menu style timeout if active
      if (this._menuStyleTimeout) {
        GLib.source_remove(this._menuStyleTimeout);
        this._menuStyleTimeout = null;
      }

      // Clean up camera check cache
      this._lastCameraCheck = null;

      this._stopCameraPreview();
      super.destroy();
    }
  },
);

export default class CamPeekExtension extends Extension {
  enable() {
    this._indicator = new CamPeekIndicator(this);
    Main.panel.addToStatusArea("campeek", this._indicator);
  }

  disable() {
    this._indicator.destroy();
    this._indicator = null;
  }
}
