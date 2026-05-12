#!/usr/bin/env python3
"""
UPRO Dip-Buy Tracker 
"""

import logging
import requests
from ib_insync import *
from datetime import datetime
import json
import os
import argparse

logging.basicConfig(level=logging.WARNING)
logging.getLogger('ib_insync.Decoder').setLevel(logging.CRITICAL)

ib = IB()
CONFIG_FILE = 'dip_buy_config.json'

def load_config():
    """Load or initialize config."""
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r') as f:
            return json.load(f)
    return {
        'target_spend': 80000,
        'last_buy_price': 137.71,
        'last_buy_shares': 580,
        'last_buy_date': datetime.now().strftime('%Y-%m-%d'),
        'dip_levels': [
            {'drop_pct': 1, 'additional_pct': 0.10},
            {'drop_pct': 2, 'additional_pct': 0.10},
            {'drop_pct': 3, 'additional_pct': 0.10},
            {'drop_pct': 4, 'additional_pct': 0.10},
            {'drop_pct': 5, 'additional_pct': 0.10},
            {'drop_pct': 6, 'additional_pct': 0.10},
            {'drop_pct': 7, 'additional_pct': 0.10},
            {'drop_pct': 8, 'additional_pct': 0.10},
            {'drop_pct': 9, 'additional_pct': 0.10},
            {'drop_pct': 10, 'additional_pct': 0.10},
        ]
    }

def save_config(config):
    """Save config."""
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)

def get_current_price():
    """Get current UPRO price."""
    contract = Stock('UPRO', 'SMART', 'USD')
    ib.qualifyContracts(contract)
    ticker = ib.reqTickers(contract)[0]
    return ticker.ask if ticker.ask else ticker.last

def log_price_to_history(price, silent=False):
    """Log current price to history file."""
    history_file = 'upro_history.csv'
    today = datetime.now().strftime('%Y-%m-%d')
    now = datetime.now().strftime('%H:%M:%S')
    
    # Check if today's entry exists
    lines = []
    found = False
    if os.path.exists(history_file):
        with open(history_file, 'r') as f:
            lines = f.readlines()
    
    # Update today's entry or add new one
    updated = False
    new_lines = []
    for line in lines:
        if line.startswith(today):
            # Update existing entry with latest price
            parts = line.strip().split(',')
            if len(parts) >= 5:
                parts[4] = str(price)  # Update close price
                new_lines.append(','.join(parts) + '\n')
                found = True
            else:
                new_lines.append(line)
        else:
            new_lines.append(line)
    
    if not found:
        # Add new entry
        new_lines.append(f"{today},{price},{price},{price},{price},0\n")
    
    with open(history_file, 'w') as f:
        f.writelines(new_lines)
    
    if not silent:
        print(f"Logged price ${price:.2f} to history")

def get_current_position():
    """Get current UPRO position."""
    positions = ib.positions()
    for pos in positions:
        if pos.contract.symbol == 'UPRO':
            return pos.position, pos.avgCost
    return 0, 0

def execute_buy(shares, price):
    """Execute a buy order and wait for it to fill."""
    contract = Stock('UPRO', 'SMART', 'USD')
    ib.qualifyContracts(contract)
    
    # Round price to 2 decimal places for IBKR
    limit_price = round(price, 2)
    order = LimitOrder('BUY', shares, limit_price)
    order.outsideRth = True
    trade = ib.placeOrder(contract, order)
    
    print(f"   Order placed: {shares} shares @ ${limit_price:.2f}. Waiting for fill...")
    
    # Wait up to 60 seconds for the order to fill
    for _ in range(60):
        ib.sleep(1)
        if trade.orderStatus.status == 'Filled':
            return True
        if trade.orderStatus.status in ['Cancelled', 'Inactive', 'ApiCancelled']:
            return False
            
    # If still not filled after 60s, return status
    return trade.orderStatus.status == 'Filled'

def check_dip_buys(silent=False):
    """Check if we should buy based on dip levels."""
    config = load_config()
    
    try:
        current_price = get_current_price()
    except Exception as e:
        msg = f"❌ Error getting price: {e}"
        print(msg)
        return
    
    # Validate price
    if current_price is None or current_price <= 0:
        print(f"❌ Invalid price received. Skipping.")
        return

    # Load required variables
    last_buy_price = config['last_buy_price']
    target_spend = config['target_spend']
    current_shares, _ = get_current_position()
    
    price_vs_last = ((current_price - last_buy_price) / last_buy_price) * 100
    drop_pct = ((last_buy_price - current_price) / last_buy_price) * 100
    
    if not silent:
        print(f"\n=== UPRO Dip Buy Tracker ===")
        print(f"Current Shares: {current_shares}")
        print(f"Last Buy Price: ${last_buy_price:.2f}")
        print(f"Current Price: ${current_price:.2f}")
        print(f"Current Price vs Last Buy Price: {price_vs_last:.1f}%")
        print()
    
    # Check each dip level
    for level in config['dip_levels']:
        if drop_pct >= level['drop_pct']:
            # Calculate shares based on target (can keep buying beyond target)
            shares_to_buy = int(target_spend / current_price)
            
            if shares_to_buy > 0:
                cost = shares_to_buy * current_price
                print(f"✅ BUY SIGNAL: {level['drop_pct']}% dip detected!")
                print(f"   Shares: {shares_to_buy}")
                print(f"   Cost: ${cost:,.2f}")
                
                # Send notification
                msg = f"🟢 UPRO BUY SIGNAL\n\n"
                msg += f"Dip: {level['drop_pct']}%\n"
                msg += f"Current Price: ${current_price:.2f}\n"
                msg += f"Shares: {shares_to_buy}\n"
                msg += f"Cost: ${cost:,.2f}\n\n"
                msg += "Executing buy..."
                print(msg)
                
                # Execute buy with a limit slightly below current to get a better fill/price
                limit_price = current_price - 0.10
                success = execute_buy(shares_to_buy, limit_price)
                
                if success:
                    # Update config with the ACTUAL price we targeted
                    config['last_buy_price'] = limit_price
                    config['last_buy_shares'] = shares_to_buy
                    config['last_buy_date'] = datetime.now().strftime('%Y-%m-%d')
                    save_config(config)
                    
                    final_msg = f"✅ BUY EXECUTED!\n\n{shares_to_buy} shares @ ${limit_price:.2f}\nTotal: ${shares_to_buy * limit_price:,.2f}"
                    print(final_msg)
                else:
                    err_msg = f"❌ Buy failed!"
                    print(err_msg)
                return
    
    if not silent:
        print("No buy signals triggered.")

def main():
    """Main function."""
    parser = argparse.ArgumentParser(description='UPRO Dip Buy Tracker')
    parser.add_argument('--silent', action='store_true', help='Only output when a buy is executed')
    args = parser.parse_args()

    if not ib.isConnected():
        try:
            ib.connect('127.0.0.1', 4002, clientId=0)
        except Exception as e:
            if not args.silent:
                print(f"Connection failed: {e}")
            return
    
    try:
        check_dip_buys(silent=args.silent)
    finally:
        ib.disconnect()

if __name__ == "__main__":
    main()
