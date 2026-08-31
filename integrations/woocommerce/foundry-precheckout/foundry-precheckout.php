<?php
/**
 * Plugin Name: Foundry Pre-checkout Inventory Guard
 * Description: Checks Foundry's live inventory rules before WooCommerce checkout.
 * Version: 1.0.0
 * Requires Plugins: woocommerce
 */

if (!defined('ABSPATH')) { exit; }

final class Foundry_Precheckout_Inventory_Guard {
    const OPTION_URL = 'foundry_precheckout_url';
    const OPTION_TOKEN = 'foundry_precheckout_token';

    public static function init() {
        add_action('admin_init', array(__CLASS__, 'register_settings'));
        add_action('admin_menu', array(__CLASS__, 'settings_page'));
        // Woo invokes cart validation for both classic checkout and Store API checkout.
        add_action('woocommerce_check_cart_items', array(__CLASS__, 'check_cart'));
    }

    public static function register_settings() {
        register_setting('foundry_precheckout', self::OPTION_URL, array('sanitize_callback' => 'esc_url_raw'));
        register_setting('foundry_precheckout', self::OPTION_TOKEN, array('sanitize_callback' => 'sanitize_text_field'));
    }

    public static function settings_page() {
        add_submenu_page('woocommerce', 'Foundry checkout', 'Foundry checkout', 'manage_woocommerce',
            'foundry-precheckout', array(__CLASS__, 'render_settings'));
    }

    public static function render_settings() {
        if (!current_user_can('manage_woocommerce')) { return; }
        ?>
        <div class="wrap"><h1>Foundry checkout protection</h1>
          <p>Paste the endpoint and one-time integration key shown on the Foundry connection page.</p>
          <form method="post" action="options.php"><?php settings_fields('foundry_precheckout'); ?>
            <table class="form-table">
              <tr><th><label for="foundry-url">Foundry endpoint</label></th><td><input class="regular-text" id="foundry-url" name="<?php echo esc_attr(self::OPTION_URL); ?>" value="<?php echo esc_attr(get_option(self::OPTION_URL)); ?>" placeholder="https://example.com/api/v1/precheckout"></td></tr>
              <tr><th><label for="foundry-token">Integration key</label></th><td><input class="regular-text" type="password" autocomplete="new-password" id="foundry-token" name="<?php echo esc_attr(self::OPTION_TOKEN); ?>" value="<?php echo esc_attr(get_option(self::OPTION_TOKEN)); ?>"></td></tr>
            </table><?php submit_button(); ?></form></div>
        <?php
    }

    public static function check_cart() {
        if (!function_exists('WC') || !WC()->cart) { return; }
        $url = trim((string) get_option(self::OPTION_URL));
        $token = trim((string) get_option(self::OPTION_TOKEN));
        if (!$url || !$token) { return; }
        $lines = array();
        foreach (WC()->cart->get_cart() as $cart_item) {
            $product = $cart_item['data'];
            $sku = $product ? $product->get_sku() : '';
            if (!$sku && $product && $product->is_type('variation')) {
                $sku = wc_get_product($product->get_parent_id())->get_sku();
            }
            $lines[] = array('skuCode' => $sku, 'name' => $product ? $product->get_name() : 'WooCommerce item',
                'quantity' => (int) $cart_item['quantity']);
        }
        $response = wp_remote_post($url, array(
            'timeout' => 4,
            'headers' => array('Authorization' => 'Bearer ' . $token, 'Content-Type' => 'application/json'),
            'body' => wp_json_encode(array('lines' => $lines)),
        ));
        if (is_wp_error($response)) {
            wc_add_notice('Foundry could not verify stock right now. Staff should confirm availability.', 'notice');
            return;
        }
        $body = json_decode(wp_remote_retrieve_body($response), true);
        if (wp_remote_retrieve_response_code($response) >= 400 || !is_array($body)) {
            wc_add_notice('Foundry could not verify stock right now. Staff should confirm availability.', 'notice');
            return;
        }
        foreach ((array) ($body['lines'] ?? array()) as $line) {
            if (($line['decision'] ?? 'ALLOW') === 'BLOCK') {
                wc_add_notice('Foundry: ' . sanitize_text_field($line['message'] ?? 'This purchase is blocked by an inventory rule.'), 'error');
            } elseif (($line['decision'] ?? 'ALLOW') === 'WARN') {
                wc_add_notice('Foundry warning: ' . sanitize_text_field($line['message'] ?? 'Please confirm stock.'), 'notice');
            }
        }
    }
}

Foundry_Precheckout_Inventory_Guard::init();
