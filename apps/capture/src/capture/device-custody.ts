/** A configured encounter cannot use this device's retained recording custody.
 * This does not identify the owning device or authorize key replacement.
 */
export class CaptureDeviceCustodyError extends Error {
  constructor() { super("capture_device_custody_unconfirmed"); }
}
