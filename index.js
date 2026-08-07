// Unofficial plugin, not affiliated with PetLibro
// Use at your own risk
// Check PetLibro's ToS before use

const axios = require('axios');
const crypto = require('crypto');

const PETLIBRO_APP_VERSION = '1.8.20';
const PETLIBRO_CLIENT_HEADERS = Object.freeze({
  'User-Agent': `PetLibro/${PETLIBRO_APP_VERSION}`,
  'source': 'ANDROID',
  'language': 'EN',
  'version': PETLIBRO_APP_VERSION
});

let Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  
  homebridge.registerPlatform("homebridge-petlibro", "PetLibroPlatform", PetLibroPlatform);
};

class PetLibroPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.feederInstances = new Map(); // Track active feeder instances
    
    // Shared authentication state across all devices
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    
    // PetLibro API configuration
    this.email = this.config.email;
    this.password = this.config.password;
    this.baseUrl = this.config.apiEndpoint || 'https://api.us.petlibro.com';
    
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }
  
  configureAccessory(accessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }
  
  // Hash password like the HomeAssistant plugin does
  hashPassword(password) {
    return crypto.createHash('md5').update(password).digest('hex');
  }
  
  async authenticate() {
    if (!this.email || !this.password) {
      throw new Error('Email and password are required in config');
    }

    try {
      this.log('Authenticating with PetLibro API...');
      
      const payload = {
        appId: 1,
        appSn: 'c35772530d1041699c87fe62348507a8',
        country: this.config.country || 'US',
        email: this.email,
        password: this.hashPassword(this.password),
        phoneBrand: '',
        phoneSystemVersion: '',
        timezone: this.config.timezone || 'America/New_York',
        thirdId: null,
        type: null
      };
      
      const response = await axios.post(`${this.baseUrl}/member/auth/login`, payload, {
        headers: {
          ...PETLIBRO_CLIENT_HEADERS,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Language': 'en-US',
          'timezone': payload.timezone
        },
        timeout: 10000
      });
      
      const data = response.data;
      if (data && data.code === 0) {
        if (data.data && data.data.token) {
          this.accessToken = data.data.token;
          this.refreshToken = data.data.refresh_token || null;
          
          const expiresIn = data.data.expires_in || 3600;
          this.tokenExpiry = Date.now() + (expiresIn * 1000);
          
          this.log('Authentication successful!');
          return;
        } else {
          throw new Error('Authentication succeeded but no token found in data.token');
        }
      } else if (data && data.code) {
        const errorMsg = data.msg || data.message || 'Unknown error';
        throw new Error(`Authentication failed: ${errorMsg} (code: ${data.code})`);
      } else {
        throw new Error('Unexpected response format');
      }
      
    } catch (error) {
      this.log.error('Authentication failed:', error.message);
      if (error.response) {
        this.log.error('   Status:', error.response.status);
        this.log.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }
  
  async refreshAuthToken() {
    if (!this.refreshToken) {
      return this.authenticate();
    }
    
    try {
      const response = await axios.post(`${this.baseUrl}/member/auth/refresh`, {
        refresh_token: this.refreshToken
      }, {
        headers: {
          ...PETLIBRO_CLIENT_HEADERS,
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`
        }
      });
      
      if (response.data && response.data.access_token) {
        this.accessToken = response.data.access_token;
        this.tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        this.log('Token refreshed successfully');
      }
    } catch (error) {
      this.log.warn('Token refresh failed, re-authenticating...');
      return this.authenticate();
    }
  }
  
  async ensureAuthenticated() {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      await this.refreshAuthToken();
    }
  }
  
  async fetchDevicesFromAPI() {
    try {
      this.log('Fetching device list from PetLibro API...');
      await this.ensureAuthenticated();
      
      const response = await axios.post(`${this.baseUrl}/device/device/list`, {}, {
        headers: {
          ...PETLIBRO_CLIENT_HEADERS,
          'Content-Type': 'application/json',
          'token': this.accessToken,
          'timezone': this.config.timezone || 'America/New_York'
        },
        timeout: 10000
      });
      
      if (response.data && response.data.code === 0 && response.data.data) {
        const devices = response.data.data;
        
        if (Array.isArray(devices) && devices.length > 0) {
          this.log(`Found ${devices.length} device(s) in PetLibro account`);
          return devices;
        } else {
          this.log.warn('No devices found in PetLibro account');
          return [];
        }
      } else if (response.data && response.data.code !== 0) {
        const errorMsg = response.data.msg || 'Unknown error';
        throw new Error(`Device list API error: ${errorMsg} (code: ${response.data.code})`);
      } else {
        throw new Error('Unexpected response format from device list endpoint');
      }
      
    } catch (error) {
      this.log.error('Failed to get devices:', error.message);
      if (error.response) {
        this.log.error('   Status:', error.response.status);
        this.log.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }
  
  async discoverDevices() {
    try {
      // Authenticate first
      await this.authenticate();
      
      // Fetch all devices from the API
      const devices = await this.fetchDevicesFromAPI();
      
      if (devices.length === 0) {
        this.log.warn('No devices found to configure');
        return;
      }
      
      // Track which UUIDs we found in the API
      const foundUUIDs = new Set();
      const newAccessories = [];
      
      // Create/update accessories for each device
      for (const device of devices) {
        const deviceSn = device.deviceSn || device.device_id || device.deviceId || device.id || device.serial;
        const deviceName = device.deviceName || device.device_name || device.name || 'Pet Feeder';
        const deviceModel = device.productName || device.product_name || device.model || 'Smart Feeder';
        
        if (!deviceSn) {
          this.log.warn('Device found without serial number, skipping:', JSON.stringify(device));
          continue;
        }
        
        const uuid = this.api.hap.uuid.generate('petlibro-feeder-' + deviceSn);
        foundUUIDs.add(uuid);
        
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
        
        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          // Update the context with latest device info
          existingAccessory.context.device = device;
          new PetLibroFeeder(this, existingAccessory, device);
          this.feederInstances.set(uuid, existingAccessory);
        } else {
          this.log.info('Adding new accessory:', deviceName, `(${deviceSn})`);
          const accessory = new this.api.platformAccessory(deviceName, uuid);
          accessory.context.device = device;
          new PetLibroFeeder(this, accessory, device);
          newAccessories.push(accessory);
          this.feederInstances.set(uuid, accessory);
        }
      }
      
      // Register all new accessories at once
      if (newAccessories.length > 0) {
        this.api.registerPlatformAccessories("homebridge-petlibro", "PetLibroPlatform", newAccessories);
        this.log.info(`Registered ${newAccessories.length} new accessory(s)`);
      }
      
      // Remove accessories that are no longer in the API
      const accessoriesToRemove = this.accessories.filter(accessory => !foundUUIDs.has(accessory.UUID));
      if (accessoriesToRemove.length > 0) {
        this.log.info(`Removing ${accessoriesToRemove.length} accessory(s) no longer in account`);
        this.api.unregisterPlatformAccessories("homebridge-petlibro", "PetLibroPlatform", accessoriesToRemove);
      }
      
    } catch (error) {
      this.log.error('Failed to discover devices:', error.message);
      // Don't throw - let Homebridge continue with other plugins
    }
  }
}

class PetLibroFeeder {
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    this.config = platform.config;
    this.device = device;
    
    // Extract device info
    this.deviceId = device.deviceSn || device.device_id || device.deviceId || device.id || device.serial;
    this.name = device.deviceName || device.device_name || device.name || 'Pet Feeder';
    this.model = device.productName || device.product_name || device.model || 'Smart Feeder';
    
    // Set accessory information
    this.accessory.getService(this.platform.api.hap.Service.AccessoryInformation)
      .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'PetLibro')
      .setCharacteristic(this.platform.api.hap.Characteristic.Model, this.model)
      .setCharacteristic(this.platform.api.hap.Characteristic.SerialNumber, this.deviceId || 'Unknown')
      .setCharacteristic(this.platform.api.hap.Characteristic.FirmwareRevision, device.firmwareVersion || device.firmware_version || '1.0.0');
    
    // Get or create the switch service
    this.switchService = this.accessory.getService(this.platform.api.hap.Service.Switch) 
      || this.accessory.addService(this.platform.api.hap.Service.Switch);
    
    this.switchService.setCharacteristic(this.platform.api.hap.Characteristic.Name, this.name);
    
    this.switchService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
    
    this.log.info(`Initialized feeder: ${this.name} (${this.deviceId})`);
  }
  
  async getOn() {
    // Always return false since this is a momentary switch for feeding
    return false;
  }
  
  async setOn(value) {
    if (value) {
      this.log(`[${this.name}] Feed button tapped! Triggering manual feeding...`);
      
      try {
        await this.triggerFeeding();
        this.log(`[${this.name}] Feeding command completed successfully`);
        
        // Reset switch to off after 1 second (momentary behavior)
        setTimeout(() => {
          this.switchService
            .getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(false);
        }, 1000);
      } catch (error) {
        this.log.error(`[${this.name}] Failed to trigger feeding:`, error.message);
        
        // Reset switch to off immediately on error
        setTimeout(() => {
          this.switchService
            .getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(false);
        }, 100);
      }
    }
  }
  
  async triggerFeeding() {
    await this.platform.ensureAuthenticated();
    
    if (!this.deviceId) {
      throw new Error('Device ID not found - cannot send feed command');
    }
    
    const portions = parseInt(this.config.portions || 1);
    this.log(`[${this.name}] Sending manual feed command (${portions} portion(s))`);
    
    const feedData = {
      deviceSn: this.deviceId,
      grainNum: portions,
      requestId: this.generateRequestId()
    };
    
    const response = await axios.post(`${this.platform.baseUrl}/device/device/manualFeeding`, feedData, {
      headers: {
        ...PETLIBRO_CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'token': this.platform.accessToken,
        'timezone': this.config.timezone || 'America/New_York'
      },
      timeout: 15000
    });
    
    if (response.status === 200) {
      if (typeof response.data === 'number' || 
          (response.data && response.data.code === 0) ||
          response.data === 0) {
        this.log(`[${this.name}] Manual feeding triggered successfully!`);
        return;
      }
    }
    
    throw new Error(`Feed command failed with status ${response.status}`);
  }
  
  generateRequestId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }
  
  getServices() {
    return [this.informationService, this.switchService];
  }
}
