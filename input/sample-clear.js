// Shopping cart implementation
function ShoppingCart() {
  this.items = [];
  this.discount = 0;
}

ShoppingCart.prototype.addItem = function(name, price, quantity) {
  var item = {
    name: name,
    price: price,
    quantity: quantity || 1
  };
  this.items.push(item);
  console.log("Added " + name + " to cart (qty: " + item.quantity + ")");
  return this;
};

ShoppingCart.prototype.removeItem = function(name) {
  for (var i = 0; i < this.items.length; i++) {
    if (this.items[i].name === name) {
      this.items.splice(i, 1);
      console.log("Removed " + name + " from cart");
      return true;
    }
  }
  console.log("Item " + name + " not found");
  return false;
};

ShoppingCart.prototype.setDiscount = function(percent) {
  if (percent < 0 || percent > 100) {
    throw new Error("Discount must be between 0 and 100");
  }
  this.discount = percent;
  console.log("Discount set to " + percent + "%");
};

ShoppingCart.prototype.getSubtotal = function() {
  var total = 0;
  for (var i = 0; i < this.items.length; i++) {
    total += this.items[i].price * this.items[i].quantity;
  }
  return total;
};

ShoppingCart.prototype.getTotal = function() {
  var subtotal = this.getSubtotal();
  var discountAmount = subtotal * (this.discount / 100);
  return Math.round((subtotal - discountAmount) * 100) / 100;
};

ShoppingCart.prototype.checkout = function() {
  if (this.items.length === 0) {
    console.log("Cart is empty!");
    return null;
  }
  var order = {
    items: this.items.slice(),
    subtotal: this.getSubtotal(),
    discount: this.discount,
    total: this.getTotal(),
    timestamp: Date.now()
  };
  console.log("Order placed: $" + order.total + " (" + order.items.length + " items)");
  this.items = [];
  return order;
};

// Usage
var cart = new ShoppingCart();
cart.addItem("Laptop", 999.99, 1);
cart.addItem("Mouse", 29.99, 2);
cart.addItem("Keyboard", 79.99, 1);
cart.setDiscount(10);
console.log("Subtotal: $" + cart.getSubtotal());
console.log("Total: $" + cart.getTotal());
var order = cart.checkout();
