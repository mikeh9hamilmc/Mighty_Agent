---
name: dip-buy
description: Monitors UPRO price and automatically executes buy orders on Interactive Brokers when the price drops by 1% or more from the last purchase price. Use this to track or trigger automated dip-buying strategies.
---

# UPRO Dip-Buy Tracker

This skill monitors the price of UPRO (ProShares UltraPro S&P500) via Interactive Brokers. It checks if the current price has dropped by a certain percentage (default 1%) relative to the last purchase price stored in its configuration.

## Features
- **Automated Monitoring**: Calculates the drop from the last buy baseline.
- **IB Integration**: Connects to TWS or IB Gateway to fetch live prices and execute orders.
- **Self-Updating**: Automatically resets the "last buy price" baseline after every successful purchase.
- **Target Spend**: Calculates share size based on a configurable target spend amount.

## Configuration
The skill's behavior is controlled by `dip_buy_config.json` located in its scripts folder.

## Usage
"Check the dip buy status"
"Run the dip buy tracker"
