import axios from 'axios';

async function test() {
  try {
    const res = await axios.get('http://localhost:3000/api/anime/stream', {
      params: {
        id: '199221',
        episode: 8,
        language: 'sub'
      }
    });
    console.log('Response:', JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
  }
}

test();
