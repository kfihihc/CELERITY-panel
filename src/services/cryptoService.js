/**
 * Encryption service for user passwords and SSH credentials
 */

const CryptoJS = require('crypto-js');
const config = require('../../config');

class CryptoService {
    constructor() {
        this.key = config.ENCRYPTION_KEY;
    }

    /**
     * Generate deterministic password from userId
     */
    generatePassword(userId) {
        const hash = CryptoJS.HmacSHA256(String(userId), this.key);
        return hash.toString(CryptoJS.enc.Hex).substring(0, 24);
    }

    /**
     * Encrypt data
     */
    encrypt(data) {
        return CryptoJS.AES.encrypt(String(data), this.key).toString();
    }

    /**
     * Decrypt data
     */
    decrypt(encryptedData) {
        const bytes = CryptoJS.AES.decrypt(encryptedData, this.key);
        return bytes.toString(CryptoJS.enc.Utf8);
    }

    /**
     * Generate random secret for node stats API
     */
    generateNodeSecret() {
        return CryptoJS.lib.WordArray.random(16).toString();
    }
}

module.exports = new CryptoService();















