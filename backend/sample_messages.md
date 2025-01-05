# Sample Messages
These messages can be sent to Jippity for testing purposes.

### `startup`: Project Zomboid
```json
{
  "command": "startup",
  "game": "Project Zomboid"
}
```

### `actions/register`: `use_item`
```json
{
  "command": "actions/register",
  "game": "Project Zomboid",
  "data": {
    "actions": [
      {
        "name": "use_item",
        "description": "Uses an item from the inventory to perform an action.",
        "schema": {
          "type": "object",
          "properties": {
            "item_id": {
              "type": "string"
            }
          },
          "required": ["item_id"]
        }
      }
    ]
  }
}
```

### `action/result`: Ate Beans
```json
{
  "command": "action/result",
  "game": "Project Zomboid",
  "data": {
    "id": "REPLACE_ME",
    "success": true,
    "message": "You ate a can of beans and feel a little less hungry."
  }
}
```

### `action/result`: Drank Soda
```json
{
  "command": "action/result",
  "game": "Project Zomboid",
  "data": {
    "id": "REPLACE_ME",
    "success": true,
    "message": "You drank a can of soda and your thirst is quenched for now."
  }
}
```

### `context`: Inventory
```json
{
  "command": "context",
  "game": "Project Zomboid",
  "data": {
    "message": "You are carrying the following items: can_of_soda, can_of_beans, dead_rat, rusty_shovel",
    "silent": true
  }
}
```

### `context`: Hungry
```json
{
  "command": "context",
  "game": "Project Zomboid",
  "data": {
    "message": "You are feeling hungry.",
    "silent": true
  }
}
```

### `context`: Thirsty
```json
{
  "command": "context",
  "game": "Project Zomboid",
  "data": {
    "message": "You are feeling thirsty.",
    "silent": true
  }
}
```

### `actions/force`: Starving
```json
{
  "command": "actions/force",
  "game": "Project Zomboid",
  "data": {
    "state": "You are carrying the following items: can_of_soda, can_of_beans, dead_rat, rusty_shovel",
    "query": "You are starving and must eat something as soon as possible",
    "ephemeral_context": false,
    "action_names": ["use_item"]
  }
}
```
