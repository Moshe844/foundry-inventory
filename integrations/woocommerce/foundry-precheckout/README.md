# StockChief pre-checkout guard for WooCommerce

1. Zip the `foundry-precheckout` folder and install it in WordPress under **Plugins → Add New → Upload Plugin**.
2. Activate it, then open **WooCommerce → StockChief checkout**.
3. In StockChief, open the WooCommerce connection and choose **Create checkout integration key**.
4. Paste the StockChief `/api/v1/precheckout` endpoint and the one-time key into WordPress.

The plugin sends only SKU, product name, and requested quantity. It never changes StockChief inventory. A StockChief `BLOCK` decision prevents checkout; `WARN` displays a notice and allows the merchant to continue.
