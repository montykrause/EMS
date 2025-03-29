// Import all required modules first
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const socketIo = require('socket.io');

// Initialize the Express app
const app = express();
const port = 3001;
const db = new sqlite3.Database('./ems.db');
const server = http.createServer(app);
const io = socketIo(server);

// Set up middleware after app is defined
app.use(cors()); // Now this works because 'app' is defined
app.use(bodyParser.json());
app.use(express.static('public'));

// Logging middleware to debug requests
app.use((req, res, next) => {
  console.log(`Received ${req.method} request to ${req.path}`);
  next();
});

// Database schema setup
db.serialize(() => {
  // Create hospitals table
  db.run(`CREATE TABLE IF NOT EXISTS hospitals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    latitude REAL,
    longitude REAL
  )`);

  // Create transport_requests table with hospitalId
  db.run(`CREATE TABLE IF NOT EXISTS transport_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patientName TEXT,
    age INTEGER,
    chiefComplaint TEXT,
    status TEXT DEFAULT 'pending',
    hospitalId INTEGER,
    FOREIGN KEY(hospitalId) REFERENCES hospitals(id)
  )`);

  // Create ambulances table
  db.run(`CREATE TABLE IF NOT EXISTS ambulances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    status TEXT DEFAULT 'available',
    latitude REAL,
    longitude REAL,
    lastUpdated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Create ambulance_inventory table for inventory tracking
  db.run(`CREATE TABLE IF NOT EXISTS ambulance_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ambulanceId INTEGER,
    supplyName TEXT,
    quantity INTEGER,
    parLevel INTEGER,
    FOREIGN KEY(ambulanceId) REFERENCES ambulances(id)
  )`);

  // Create notifications table for in-app alerts
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ambulanceId INTEGER,
    supplyName TEXT,
    currentQuantity INTEGER,
    parLevel INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'unread',
    FOREIGN KEY(ambulanceId) REFERENCES ambulances(id)
  )`);

  // Add columns to ambulances table
  db.run(`ALTER TABLE ambulances ADD COLUMN shift_length_hours INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err.message);
  });
  db.run(`ALTER TABLE ambulances ADD COLUMN designation_level INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err.message);
  });
  db.run(`ALTER TABLE ambulances ADD COLUMN shift_start TIMESTAMP`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err.message);
  });
  db.run(`ALTER TABLE ambulances ADD COLUMN last_call_end TIMESTAMP`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err.message);
  });
  db.run(`ALTER TABLE ambulances ADD COLUMN on_break INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err.message);
  });

  // Add columns to transport_requests table
  db.run(`ALTER TABLE transport_requests ADD COLUMN callType TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err.message);
  });
  db.run(`ALTER TABLE transport_requests ADD COLUMN ambulanceId INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err.message);
  });
  db.run(`ALTER TABLE transport_requests ADD COLUMN needsApproval INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err.message);
  });
  db.run(`ALTER TABLE transport_requests ADD COLUMN hospitalId INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error(err.message);
  });

  // Create PCR table
  db.run(`CREATE TABLE IF NOT EXISTS pcrs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transportRequestId INTEGER,
    patientName TEXT,
    age INTEGER,
    gender TEXT,
    chiefComplaint TEXT,
    vitalSigns TEXT,
    medicalHistory TEXT,
    assessment TEXT,
    interventions TEXT,
    narrative TEXT,
    timestamps TEXT,
    crewInfo TEXT,
    outcome TEXT,
    FOREIGN KEY(transportRequestId) REFERENCES transport_requests(id)
  )`);

  // Insert sample inventory data for testing
  db.run(`INSERT OR IGNORE INTO ambulance_inventory (ambulanceId, supplyName, quantity, parLevel) VALUES (1, 'Oxygen Tank', 5, 2)`);
  db.run(`INSERT OR IGNORE INTO ambulance_inventory (ambulanceId, supplyName, quantity, parLevel) VALUES (1, 'Bandages', 10, 5)`);
});

// Function to calculate distance using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

// Function to check par level and generate in-app notification
function checkParLevel(ambulanceId, supplyName) {
  db.get(
    `SELECT quantity, parLevel FROM ambulance_inventory WHERE ambulanceId = ? AND supplyName = ?`,
    [ambulanceId, supplyName],
    (err, row) => {
      if (err) {
        console.error('Error checking par level:', err.message);
      } else if (row && row.quantity < row.parLevel) {
        db.run(
          `INSERT INTO notifications (ambulanceId, supplyName, currentQuantity, parLevel) 
           VALUES (?, ?, ?, ?)`,
          [ambulanceId, supplyName, row.quantity, row.parLevel],
          (insertErr) => {
            if (insertErr) {
              console.error('Error inserting notification:', insertErr.message);
            } else {
              console.log(`Notification created for low ${supplyName} on ambulance ${ambulanceId}`);
              io.emit('newNotification', {
                ambulanceId,
                supplyName,
                currentQuantity: row.quantity,
                parLevel: row.parLevel,
                timestamp: new Date().toISOString()
              });
            }
          }
        );
      }
    }
  );
}

// Helper functions
function calculateIdleTime(shiftStart, lastCallEnd) {
  const now = new Date();
  const referenceTime = lastCallEnd ? new Date(lastCallEnd) : new Date(shiftStart);
  return (now - referenceTime) / 3600000; // Convert milliseconds to hours
}

async function getEstimatedTime(ambulance, hospitalLat, hospitalLon) {
  // Placeholder: Replace with a real mapping API (e.g., Google Maps Distance Matrix API)
  return 10; // Simulated travel time in minutes
}

// Define designation levels for call types
const levelMap = { 'Wheelchair': 1, 'BLS': 2, 'ALS': 3, 'CCT': 4 };

// Routes
app.get('/', (req, res) => {
  res.send('Hello, Unified EMS!');
});

// Endpoint to fetch closest ambulances per service level for the hospital dashboard
app.get('/closest-ambulances', (req, res) => {
  const hospitalId = req.query.hospitalId;
  if (!hospitalId) {
    return res.status(400).send('Missing hospitalId');
  }

  db.get(`SELECT latitude, longitude FROM hospitals WHERE id = ?`, [hospitalId], (err, hospital) => {
    if (err || !hospital) {
      return res.status(404).send('Hospital not found');
    }
    const hospitalLat = hospital.latitude;
    const hospitalLon = hospital.longitude;

    const sql = `SELECT * FROM ambulances WHERE status = 'available' AND on_break = 0`;
    db.all(sql, [], (err, ambulances) => {
      if (err) {
        console.error('Error fetching ambulances:', err.message);
        return res.status(500).send('Error fetching ambulances');
      }

      const serviceLevels = ['Wheelchair', 'BLS', 'ALS', 'CCT'];
      const closestAmbulances = {};

      serviceLevels.forEach(level => {
        const levelAmbulances = ambulances.filter(a => a.designation_level === levelMap[level]);
        if (levelAmbulances.length > 0) {
          const closest = levelAmbulances.reduce((prev, curr) => {
            const prevDistance = calculateDistance(hospitalLat, hospitalLon, prev.latitude, prev.longitude);
            const currDistance = calculateDistance(hospitalLat, hospitalLon, curr.latitude, curr.longitude);
            return prevDistance < currDistance ? prev : curr;
          });
          const distance = calculateDistance(hospitalLat, hospitalLon, closest.latitude, closest.longitude);
          const eta = Math.round(distance / 50 * 60); // Assume 50 km/h average speed
          closestAmbulances[level] = { name: closest.name, eta };
        } else {
          closestAmbulances[level] = null;
        }
      });

      res.json(closestAmbulances);
    });
  });
});

// Endpoint to create a transport request with hospitalId
app.post('/transport-request', (req, res) => {
  const { patientName, age, chiefComplaint, callType, hospitalId, hospitalLatitude, hospitalLongitude } = req.body;

  if (!patientName || !age || !chiefComplaint || !callType || !hospitalId || !hospitalLatitude || !hospitalLongitude) {
    return res.status(400).send('Missing required fields');
  }

  const callLevel = levelMap[callType];
  if (!callLevel) {
    return res.status(400).send('Invalid call type');
  }

  const sqlInsert = `INSERT INTO transport_requests (patientName, age, chiefComplaint, callType, status, hospitalId) VALUES (?, ?, ?, ?, 'pending', ?)`;
  db.run(sqlInsert, [patientName, age, chiefComplaint, callType, hospitalId], function(err) {
    if (err) {
      console.error('Error inserting request:', err.message);
      return res.status(500).send('Error saving request');
    }
    const requestId = this.lastID;
    console.log(`Transport request saved with ID: ${requestId}`);

    const sqlAvailable = `SELECT * FROM ambulances WHERE status = 'available' AND on_break = 0`;
    db.all(sqlAvailable, [], (err, ambulances) => {
      if (err) {
        console.error('Error fetching ambulances:', err.message);
        return res.status(500).send('Error fetching ambulances');
      }
      if (ambulances.length === 0) {
        return res.status(404).send('No available ambulances');
      }

      const eligibleAmbulances = ambulances.filter(ambulance => {
        const ambulanceLevel = ambulance.designation_level;
        return ambulanceLevel === callLevel || (ambulanceLevel === callLevel + 1 && callLevel < 4);
      });

      if (eligibleAmbulances.length === 0) {
        return res.status(404).send('No suitable ambulances available');
      }

      Promise.all(eligibleAmbulances.map(async (ambulance) => {
        const idleTime = calculateIdleTime(ambulance.shift_start, ambulance.last_call_end);
        const travelTime = await getEstimatedTime(ambulance, hospitalLatitude, hospitalLongitude);
        return { ...ambulance, idleTime, travelTime };
      })).then(ambulancesWithData => {
        ambulancesWithData.sort((a, b) => {
          if (a.shift_length_hours !== b.shift_length_hours) {
            return a.shift_length_hours - b.shift_length_hours;
          } else if (a.idleTime !== b.idleTime) {
            return b.idleTime - a.idleTime;
          } else {
            return a.travelTime - b.travelTime;
          }
        });

        const selectedAmbulance = ambulancesWithData[0];
        const needsApproval = selectedAmbulance.designation_level > callLevel ? 1 : 0;

        const sqlUpdateRequest = `UPDATE transport_requests SET status = 'assigned', ambulanceId = ?, needsApproval = ? WHERE id = ?`;
        db.run(sqlUpdateRequest, [selectedAmbulance.id, needsApproval, requestId], function(err) {
          if (err) {
            console.error('Error assigning ambulance:', err.message);
            return res.status(500).send('Error assigning ambulance');
          }

          const sqlUpdateAmbulance = `UPDATE ambulances SET status = 'en route' WHERE id = ?`;
          db.run(sqlUpdateAmbulance, [selectedAmbulance.id], function(err) {
            if (err) {
              console.error('Error updating ambulance status:', err.message);
              return res.status(500).send('Error updating ambulance status');
            }

            const message = needsApproval
              ? `Ambulance ${selectedAmbulance.name} assigned to request ${requestId}, pending supervisor approval`
              : `Ambulance ${selectedAmbulance.name} assigned to request ${requestId}`;
            res.send(message);
          });
        });
      }).catch(err => {
        console.error('Error processing ambulance data:', err.message);
        res.status(500).send('Error processing ambulance data');
      });
    });
  });
});

// Endpoint to fetch pending transports for a hospital
app.get('/pending-transports', (req, res) => {
  const hospitalId = req.query.hospitalId;
  if (!hospitalId) {
    return res.status(400).send('Missing hospitalId');
  }

  const sql = `SELECT tr.id, tr.status, a.name as ambulanceName, a.latitude, a.longitude
               FROM transport_requests tr
               LEFT JOIN ambulances a ON tr.ambulanceId = a.id
               WHERE tr.hospitalId = ? AND tr.status != 'completed'`;
  db.all(sql, [hospitalId], (err, rows) => {
    if (err) {
      console.error('Error fetching pending transports:', err.message);
      return res.status(500).send('Error fetching pending transports');
    }
    res.json(rows);
  });
});

// Endpoint to request a break for an ambulance
app.post('/request-break', (req, res) => {
  const { ambulanceId } = req.body;

  if (!ambulanceId) {
    return res.status(400).send('Missing ambulanceId');
  }

  const sqlFetch = `SELECT shift_start, status FROM ambulances WHERE id = ?`;
  db.get(sqlFetch, [ambulanceId], (err, ambulance) => {
    if (err || !ambulance) {
      return res.status(404).send('Ambulance not found');
    }

    const hoursOnShift = (new Date() - new Date(ambulance.shift_start)) / 3600000;
    if (hoursOnShift < 12) {
      return res.status(403).send('Cannot take break yet. Must be on shift for at least 12 hours.');
    }
    if (ambulance.status !== 'available') {
      return res.status(403).send('Cannot take break while on a call.');
    }

    const sqlUpdate = `UPDATE ambulances SET on_break = 1 WHERE id = ?`;
    db.run(sqlUpdate, [ambulanceId], (err) => {
      if (err) {
        console.error('Error granting break:', err.message);
        return res.status(500).send('Error granting break');
      }
      setTimeout(() => {
        db.run(`UPDATE ambulances SET on_break = 0 WHERE id = ?`, [ambulanceId], (err) => {
          if (err) console.error('Error ending break:', err.message);
        });
      }, 2 * 60 * 60 * 1000); // 2 hours in milliseconds
      res.send('Break granted. Status will revert to available in 2 hours.');
    });
  });
});

// Endpoint to update ambulance location
app.post('/update-location', (req, res) => {
  const { name, latitude, longitude } = req.body;
  const sql = `UPDATE ambulances SET latitude = ?, longitude = ?, lastUpdated = CURRENT_TIMESTAMP WHERE name = ?`;
  db.run(sql, [latitude, longitude, name], function(err) {
    if (err) {
      console.error('Error updating location:', err.message);
      return res.status(500).send('Error updating location');
    }
    if (this.changes === 0) {
      const insertSql = `INSERT INTO ambulances (name, latitude, longitude) VALUES (?, ?, ?)`;
      db.run(insertSql, [name, latitude, longitude], function(insertErr) {
        if (insertErr) {
          console.error('Error inserting ambulance:', insertErr.message);
          return res.status(500).send('Error inserting ambulance');
        }
        console.log(`Ambulance ${name} added with location: ${latitude}, ${longitude}`);
        io.emit('locationUpdate', { name, latitude, longitude });
        res.send(`Ambulance ${name} added with location: ${latitude}, ${longitude}`);
      });
    } else {
      console.log(`Location updated for ${name}: ${latitude}, ${longitude}`);
      io.emit('locationUpdate', { name, latitude, longitude });
      res.send(`Location updated for ${name}: ${latitude}, ${longitude}`);
    }
  });
});

// Endpoint to update ambulance status
app.post('/update-status', (req, res) => {
  const { ambulanceId, status } = req.body;
  const validStatuses = ['available', 'en route', 'on scene', 'arrived at patient', 'transporting', 'completed'];

  if (!ambulanceId || !status) {
    return res.status(400).send('Missing ambulanceId or status');
  }
  if (!validStatuses.includes(status)) {
    return res.status(400).send('Invalid status');
  }

  const sql = `UPDATE ambulances SET status = ? WHERE id = ?`;
  db.run(sql, [status, ambulanceId], function(err) {
    if (err) {
      console.error('Error updating status:', err.message);
      return res.status(500).send('Error updating status');
    }
    if (this.changes === 0) {
      return res.status(404).send('Ambulance not found');
    }
    console.log(`Status updated for ambulance ${ambulanceId}: ${status}`);
    io.emit('statusUpdate', { ambulanceId, status });

    if (status === 'en route' || status === 'completed') {
      const requestSql = `SELECT id FROM transport_requests WHERE ambulanceId = ? AND status != 'completed'`;
      db.get(requestSql, [ambulanceId], (err, request) => {
        if (err) {
          console.error('Error fetching request:', err.message);
        } else if (request) {
          let newRequestStatus = status === 'en route' ? 'in progress' : 'completed';
          const updateRequestSql = `UPDATE transport_requests SET status = ? WHERE id = ?`;
          db.run(updateRequestSql, [newRequestStatus, request.id], function(err) {
            if (err) {
              console.error('Error updating request status:', err.message);
            } else {
              console.log(`Request ${request.id} status updated to ${newRequestStatus}`);
            }
          });
        }
      });
    }
    res.send(`Status updated to ${status} for ambulance ${ambulanceId}`);
  });
});

// Endpoint to submit PCRs with inventory updates
app.post('/submit-pcr', (req, res) => {
  const {
    transportRequestId,
    patientName,
    age,
    gender,
    chiefComplaint,
    vitalSigns,
    medicalHistory,
    assessment,
    interventions,
    narrative,
    timestamps,
    crewInfo,
    outcome
  } = req.body;

  if (!transportRequestId || !patientName || !chiefComplaint) {
    return res.status(400).send('Missing required fields');
  }

  const sql = `INSERT INTO pcrs (
    transportRequestId, patientName, age, gender, chiefComplaint,
    vitalSigns, medicalHistory, assessment, interventions, narrative,
    timestamps, crewInfo, outcome
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(sql, [
    transportRequestId, patientName, age, gender, chiefComplaint,
    vitalSigns, medicalHistory, assessment, interventions, narrative,
    timestamps, crewInfo, outcome
  ], function(err) {
    if (err) {
      console.error('Error inserting PCR:', err.message);
      return res.status(500).send('Error saving PCR');
    }
    console.log(`PCR saved with ID: ${this.lastID} for request ${transportRequestId}`);

    db.get(`SELECT ambulanceId FROM transport_requests WHERE id = ?`, [transportRequestId], (err, request) => {
      if (err || !request) {
        console.error('Error fetching ambulanceId:', err ? err.message : 'Request not found');
        return;
      }
      const ambulanceId = request.ambulanceId;
      let usedSupplies;
      try {
        usedSupplies = JSON.parse(interventions);
      } catch (parseErr) {
        console.error('Error parsing interventions:', parseErr.message);
        return;
      }
      if (typeof usedSupplies !== 'object' || usedSupplies === null) {
        console.error('Interventions is not a valid object');
        return;
      }
      Object.entries(usedSupplies).forEach(([supplyName, quantityUsed]) => {
        db.run(
          `UPDATE ambulance_inventory SET quantity = quantity - ? WHERE ambulanceId = ? AND supplyName = ?`,
          [quantityUsed, ambulanceId, supplyName],
          (err) => {
            if (err) {
              console.error(`Error updating ${supplyName}:`, err.message);
            } else {
              console.log(`Updated ${supplyName} for ambulance ${ambulanceId}`);
              checkParLevel(ambulanceId, supplyName);
            }
          }
        );
      });
    });

    res.send(`PCR saved with ID: ${this.lastID}`);
  });
});

// Endpoint to fetch unread notifications
app.get('/notifications', (req, res) => {
  db.all(`SELECT * FROM notifications WHERE status = 'unread'`, [], (err, rows) => {
    if (err) {
      console.error('Error fetching notifications:', err.message);
      return res.status(500).send('Error fetching notifications');
    }
    res.json(rows);
  });
});

// Endpoint to mark notification as read
app.post('/mark-notification-read', (req, res) => {
  const { notificationId } = req.body;
  if (!notificationId) {
    return res.status(400).send('Missing notificationId');
  }
  db.run(`UPDATE notifications SET status = 'read' WHERE id = ?`, [notificationId], (err) => {
    if (err) {
      console.error('Error marking notification as read:', err.message);
      return res.status(500).send('Error marking notification as read');
    }
    res.send('Notification marked as read');
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start the server
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});