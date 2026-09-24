package cn.lingshi.familytree.controller;

import static org.hamcrest.Matchers.hasSize;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import cn.lingshi.familytree.entity.Family;
import cn.lingshi.familytree.mapper.FamilyMapper;
import java.time.LocalDateTime;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

@SpringBootTest
class PersonCrudIntegrationTests {
    @Autowired
    private WebApplicationContext context;
    @Autowired
    private FamilyMapper familyMapper;
    private MockMvc mockMvc;
    private Long familyId;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context).build();
        Family family = new Family();
        family.setName("测试族谱");
        family.setDescription("Person CRUD 自动测试");
        family.setCreatedAt(LocalDateTime.now());
        family.setUpdatedAt(LocalDateTime.now());
        familyMapper.insert(family);
        familyId = family.getId();
    }

    @Test
    void personCrudUsesLogicalDelete() throws Exception {
        String createBody = """
                {"familyId":%d,"name":"凌测试","gender":"男","generation":3,
                 "birthDate":"2000-05-18","biography":"测试人物"}
                """.formatted(familyId);
        String created = mockMvc.perform(post("/api/persons")
                        .contentType(MediaType.APPLICATION_JSON).content(createBody))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.name").value("凌测试"))
                .andReturn().getResponse().getContentAsString();
        long personId = Long.parseLong(created.replaceAll(".*\\\"id\\\":(\\d+).*", "$1"));

        mockMvc.perform(get("/api/persons/{id}", personId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.generation").value(3));

        mockMvc.perform(get("/api/persons").param("familyId", familyId.toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.records", hasSize(1)));

        String updateBody = """
                {"familyId":%d,"name":"凌测试改","gender":"男","generation":4,
                 "birthDate":"2000-05-18","biography":"已修改","version":1}
                """.formatted(familyId);
        mockMvc.perform(put("/api/persons/{id}", personId)
                        .contentType(MediaType.APPLICATION_JSON).content(updateBody))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("凌测试改"))
                .andExpect(jsonPath("$.version").value(2));

        mockMvc.perform(delete("/api/persons/{id}", personId))
                .andExpect(status().isNoContent());
        mockMvc.perform(get("/api/persons/{id}", personId))
                .andExpect(status().isBadRequest());
    }
}
